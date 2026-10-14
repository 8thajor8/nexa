import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

export const AUDIO_DUCKING_FACTOR = 0.2;
const RESTORE_MATCH_TOLERANCE = 0.005;
const MAX_BRIDGE_OUTPUT_BYTES = 256 * 1024;
const BRIDGE_TIMEOUT_MS = 8_000;

export interface AudioSessionSnapshot {
  deviceId: string;
  sessionId: string;
  processId: number;
  originalVolume: number;
  duckedVolume: number;
}

export interface AudioDuckingAdapter {
  duck(rootProcessId: number, factor: number): Promise<{ sessions: AudioSessionSnapshot[]; failedSessions: number }>;
  restore(sessions: readonly AudioSessionSnapshot[]): Promise<{ restored: number; skipped: number; failedSessions: number }>;
}

export interface AudioDuckingDiagnostics {
  (event: "started" | "restored" | "failed", details: Readonly<{ stage: "duck" | "restore"; code: string; sessionCount?: number }>): void;
}

export function calculateDuckedVolume(originalVolume: number, factor = AUDIO_DUCKING_FACTOR): number {
  if (!Number.isFinite(originalVolume) || originalVolume < 0 || originalVolume > 1
    || !Number.isFinite(factor) || factor < 0 || factor > 1) throw new RangeError("invalid_audio_ducking_volume");
  return originalVolume * factor;
}

export function shouldRestoreAudioSession(currentVolume: number, duckedVolume: number): boolean {
  return Number.isFinite(currentVolume) && Number.isFinite(duckedVolume)
    && Math.abs(currentVolume - duckedVolume) <= RESTORE_MATCH_TOLERANCE;
}

export function createAudioSessionDucking(options: {
  platform?: NodeJS.Platform;
  rootProcessId?: number;
  adapter?: AudioDuckingAdapter;
  diagnostics?: AudioDuckingDiagnostics;
} = {}) {
  const platform = options.platform ?? process.platform;
  const rootProcessId = options.rootProcessId ?? process.pid;
  const adapter = options.adapter ?? (platform === "win32" ? createWindowsCoreAudioAdapter() : null);
  const diagnostics = options.diagnostics ?? (() => undefined);
  const leases = new Set<string>();
  let snapshots: AudioSessionSnapshot[] | null = null;
  let queue: Promise<void> = Promise.resolve();
  let disposed = false;

  const report = (event: "started" | "restored" | "failed", stage: "duck" | "restore", code: string, sessionCount?: number) => {
    try { diagnostics(event, { stage, code, ...(sessionCount === undefined ? {} : { sessionCount }) }); }
    catch { /* Diagnostics never affect Voice. */ }
  };
  const enqueue = (operation: () => Promise<void>): Promise<void> => {
    const next = queue.then(operation, operation);
    queue = next.catch(() => undefined);
    return next;
  };

  async function restoreIfIdle(): Promise<void> {
    if (leases.size > 0 || snapshots === null) return;
    const previous = snapshots;
    snapshots = null;
    if (!adapter || previous.length === 0) return;
    try {
      const result = await adapter.restore(previous);
      report("restored", "restore", result.failedSessions > 0 ? "partial_restore" : "ok",
        result.restored + result.skipped);
    } catch {
      report("failed", "restore", "restore_failed", previous.length);
    }
  }

  async function begin(requestId: string): Promise<void> {
    if (disposed || platform !== "win32" || !adapter || typeof requestId !== "string" || !requestId) return;
    leases.add(requestId);
    await enqueue(async () => {
      if (disposed || leases.size === 0 || snapshots !== null) return;
      try {
        const result = await adapter.duck(rootProcessId, AUDIO_DUCKING_FACTOR);
        snapshots = result.sessions;
        report("started", "duck", result.failedSessions > 0 ? "partial_duck" : "ok", result.sessions.length);
        await restoreIfIdle();
      } catch {
        snapshots = null;
        report("failed", "duck", "duck_failed");
      }
    });
  }

  function transfer(previousRequestId: string, nextRequestId: string): void {
    if (previousRequestId === nextRequestId || !leases.delete(previousRequestId)) return;
    leases.add(nextRequestId);
  }

  async function end(requestId: string): Promise<void> {
    leases.delete(requestId);
    await enqueue(restoreIfIdle);
  }

  async function endExcept(requestId: string | null): Promise<void> {
    for (const lease of leases) if (lease !== requestId) leases.delete(lease);
    await enqueue(restoreIfIdle);
  }

  async function close(): Promise<void> {
    disposed = true;
    leases.clear();
    await enqueue(restoreIfIdle);
  }

  return Object.freeze({ begin, transfer, end, endExcept, close });
}

function createWindowsCoreAudioAdapter(): AudioDuckingAdapter {
  type Pending = { resolve(value: Record<string, unknown>): void; reject(error: Error): void; timeout: NodeJS.Timeout };
  type Worker = { child: ReturnType<typeof spawn>; closed: Promise<void>; resolveClosed(): void; output: string };
  let worker: Worker | null = null;
  const pending = new Map<string, Pending>();

  function failWorker(current: Worker, error: Error): void {
    if (worker === current) worker = null;
    for (const [id, item] of pending) {
      clearTimeout(item.timeout);
      item.reject(error);
      pending.delete(id);
    }
  }

  function ensureWorker(): Worker {
    if (worker) return worker;
    const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_CORE_AUDIO_SCRIPT], {
      windowsHide: true, stdio: ["pipe", "pipe", "ignore"],
    });
    let resolveClosed!: () => void;
    const current: Worker = { child, closed: new Promise<void>((resolve) => { resolveClosed = resolve; }), resolveClosed: () => resolveClosed(), output: "" };
    worker = current;
    child.stdout.on("data", (chunk: Buffer) => {
      current.output += chunk.toString("utf8");
      if (Buffer.byteLength(current.output, "utf8") > MAX_BRIDGE_OUTPUT_BYTES) {
        current.output = "";
        failWorker(current, new Error("audio_duck_bridge_output_limit"));
        void sendCommand("restore", { sessions: [] }).catch(() => undefined);
        return;
      }
      let newline = current.output.indexOf("\n");
      while (newline >= 0) {
        const line = current.output.slice(0, newline).trim();
        current.output = current.output.slice(newline + 1);
        if (line) {
          try {
            const reply = JSON.parse(line) as Record<string, unknown>;
            const id = typeof reply.requestId === "string" ? reply.requestId : "";
            const item = pending.get(id);
            if (item) {
              pending.delete(id);
              clearTimeout(item.timeout);
              if (reply.ok === true) item.resolve(reply);
              else item.reject(new Error("core_audio_operation_failed"));
            }
          } catch { /* Invalid helper output is ignored; the bounded request timer handles it. */ }
        }
        newline = current.output.indexOf("\n");
      }
    });
    child.once("error", () => failWorker(current, new Error("audio_duck_bridge_failed")));
    child.once("close", () => {
      failWorker(current, new Error("audio_duck_bridge_closed"));
      current.resolveClosed();
    });
    return current;
  }

  function sendCommand(action: "duck" | "restore", values: Record<string, unknown>): Promise<Record<string, unknown>> {
    const current = ensureWorker();
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error("audio_duck_bridge_timeout"));
        if (action === "duck") void sendCommand("restore", { sessions: [] }).catch(() => undefined);
      }, BRIDGE_TIMEOUT_MS);
      pending.set(requestId, { resolve, reject, timeout });
      const input = current.child.stdin;
      if (!input) {
        pending.delete(requestId);
        clearTimeout(timeout);
        reject(new Error("audio_duck_bridge_failed"));
        return;
      }
      input.write(`${JSON.stringify({ ...values, action, requestId })}\n`, "utf8", (error) => {
        if (!error) return;
        const item = pending.get(requestId);
        if (!item) return;
        pending.delete(requestId);
        clearTimeout(item.timeout);
        item.reject(new Error("audio_duck_bridge_failed"));
      });
    });
  }

  return {
    async duck(rootProcessId, factor) {
      let result: Record<string, unknown>;
      try { result = await sendCommand("duck", { rootProcessId, factor }); }
      catch (error) {
        await sendCommand("restore", { sessions: [] }).catch(() => undefined);
        const current = worker;
        if (current) await current.closed;
        throw error;
      }
      if (!Array.isArray(result.sessions)) throw new Error("audio_duck_response_invalid");
      const sessions = result.sessions.filter(isAudioSessionSnapshot);
      if (sessions.length === 0) {
        await sendCommand("restore", { sessions: [] }).catch(() => undefined);
        const current = worker;
        if (current) await current.closed;
      }
      return { sessions, failedSessions: safeCount(result.failedSessions) };
    },
    async restore(sessions) {
      if (!worker) return { restored: 0, skipped: sessions.length, failedSessions: 0 };
      const current = worker;
      const result = await sendCommand("restore", { sessions });
      await current.closed;
      return { restored: safeCount(result.restored), skipped: safeCount(result.skipped),
        failedSessions: safeCount(result.failedSessions) };
    },
  };
}

function safeCount(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0;
}

function isAudioSessionSnapshot(value: unknown): value is AudioSessionSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return typeof item.deviceId === "string" && item.deviceId.length > 0
    && typeof item.sessionId === "string" && item.sessionId.length > 0
    && Number.isSafeInteger(item.processId) && (item.processId as number) > 0
    && typeof item.originalVolume === "number" && Number.isFinite(item.originalVolume)
    && item.originalVolume >= 0 && item.originalVolume <= 1
    && typeof item.duckedVolume === "number" && Number.isFinite(item.duckedVolume)
    && item.duckedVolume >= 0 && item.duckedVolume <= 1;
}

const WINDOWS_CORE_AUDIO_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class NexaCoreAudioDucking {
  private const int CLSCTX_ALL = 23;
  private const int SnapshotFlag = 2;
  private const uint InvalidProcessId = 0;
  private static readonly Guid EnumeratorClass = new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E");
  private static readonly Guid SessionManagerId = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct PROCESSENTRY32 {
    public uint dwSize, cntUsage, th32ProcessID;
    public IntPtr th32DefaultHeapID;
    public uint th32ModuleID, cntThreads, th32ParentProcessID;
    public int pcPriClassBase;
    public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
  }

  [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
  [DllImport("kernel32.dll", EntryPoint = "Process32FirstW", CharSet = CharSet.Unicode, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)] private static extern bool Process32First(IntPtr snapshot, ref PROCESSENTRY32 entry);
  [DllImport("kernel32.dll", EntryPoint = "Process32NextW", CharSet = CharSet.Unicode, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)] private static extern bool Process32Next(IntPtr snapshot, ref PROCESSENTRY32 entry);
  [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CloseHandle(IntPtr handle);

  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IMMDeviceEnumerator {
    [PreserveSig] int EnumAudioEndpoints(int flow, int mask, out IntPtr devices);
    [PreserveSig] int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice device);
    [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
    [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr callback);
    [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr callback);
  }

  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IMMDevice {
    [PreserveSig] int Activate(ref Guid iid, int clsctx, IntPtr parameters, [MarshalAs(UnmanagedType.IUnknown)] out object result);
    [PreserveSig] int OpenPropertyStore(int access, out IntPtr properties);
    [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    [PreserveSig] int GetState(out int state);
  }

  [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IAudioSessionManager2 {
    [PreserveSig] int GetAudioSessionControl(IntPtr sessionGuid, int flags, out IntPtr control);
    [PreserveSig] int GetSimpleAudioVolume(IntPtr sessionGuid, int flags, out IntPtr volume);
    [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator sessions);
    [PreserveSig] int RegisterSessionNotification(IntPtr notification);
    [PreserveSig] int UnregisterSessionNotification(IntPtr notification);
    [PreserveSig] int RegisterDuckNotification([MarshalAs(UnmanagedType.LPWStr)] string sessionId, IntPtr notification);
    [PreserveSig] int UnregisterDuckNotification(IntPtr notification);
  }

  [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IAudioSessionEnumerator {
    [PreserveSig] int GetCount(out int count);
    [PreserveSig] int GetSession(int index, out IAudioSessionControl control);
  }

  [ComImport, Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IAudioSessionControl {
    [PreserveSig] int GetState(out int state);
    [PreserveSig] int GetDisplayName(out IntPtr name);
    [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string name, ref Guid context);
    [PreserveSig] int GetIconPath(out IntPtr path);
    [PreserveSig] int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string path, ref Guid context);
    [PreserveSig] int GetGroupingParam(out Guid grouping);
    [PreserveSig] int SetGroupingParam(ref Guid grouping, ref Guid context);
    [PreserveSig] int RegisterAudioSessionNotification(IntPtr notification);
    [PreserveSig] int UnregisterAudioSessionNotification(IntPtr notification);
  }

  [ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IAudioSessionControl2 : IAudioSessionControl {
    [PreserveSig] new int GetState(out int state);
    [PreserveSig] new int GetDisplayName(out IntPtr name);
    [PreserveSig] new int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string name, ref Guid context);
    [PreserveSig] new int GetIconPath(out IntPtr path);
    [PreserveSig] new int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string path, ref Guid context);
    [PreserveSig] new int GetGroupingParam(out Guid grouping);
    [PreserveSig] new int SetGroupingParam(ref Guid grouping, ref Guid context);
    [PreserveSig] new int RegisterAudioSessionNotification(IntPtr notification);
    [PreserveSig] new int UnregisterAudioSessionNotification(IntPtr notification);
    [PreserveSig] int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
    [PreserveSig] int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
    [PreserveSig] int GetProcessId(out uint processId);
    [PreserveSig] int IsSystemSoundsSession();
    [PreserveSig] int SetDuckingPreference([MarshalAs(UnmanagedType.Bool)] bool optOut);
  }

  [ComImport, Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface ISimpleAudioVolume {
    [PreserveSig] int GetMasterVolume(out float volume);
    [PreserveSig] int SetMasterVolume(float volume, ref Guid context);
    [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool muted);
    [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool muted, ref Guid context);
  }

  private sealed class SessionRef {
    public string DeviceId;
    public string SessionId;
    public uint ProcessId;
    public IAudioSessionControl Control;
    public IAudioSessionControl2 Control2;
    public ISimpleAudioVolume Volume;
    public int State;
  }

  private static void Check(int hr) { if (hr < 0) Marshal.ThrowExceptionForHR(hr); }
  private static IMMDeviceEnumerator CreateEnumerator() {
    var type = Type.GetTypeFromCLSID(EnumeratorClass, true);
    return (IMMDeviceEnumerator)Activator.CreateInstance(type);
  }

  private static HashSet<uint> GetOwnedProcessIds(uint rootProcessId) {
    var snapshot = CreateToolhelp32Snapshot(SnapshotFlag, 0);
    if (snapshot == new IntPtr(-1)) throw new InvalidOperationException("process_tree_unavailable");
    try {
      var parents = new Dictionary<uint, uint>();
      var entry = new PROCESSENTRY32(); entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
      if (!Process32First(snapshot, ref entry)) throw new InvalidOperationException("process_tree_unavailable");
      do { parents[entry.th32ProcessID] = entry.th32ParentProcessID; entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32)); }
      while (Process32Next(snapshot, ref entry));
      if (!parents.ContainsKey(rootProcessId)) throw new InvalidOperationException("process_root_unavailable");
      var owned = new HashSet<uint> { rootProcessId };
      bool changed;
      do {
        changed = false;
        foreach (var pair in parents) if (!owned.Contains(pair.Key) && owned.Contains(pair.Value)) { owned.Add(pair.Key); changed = true; }
      } while (changed);
      return owned;
    } finally { CloseHandle(snapshot); }
  }

  private static List<SessionRef> GetSessions(IMMDeviceEnumerator enumerator, IMMDevice device, string deviceId) {
    var iid = SessionManagerId;
    object managerObject;
    Check(device.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out managerObject));
    var manager = (IAudioSessionManager2)managerObject;
    IAudioSessionEnumerator sessions;
    Check(manager.GetSessionEnumerator(out sessions));
    try {
      int count; Check(sessions.GetCount(out count));
      var result = new List<SessionRef>();
      for (int index = 0; index < count; index++) {
        IAudioSessionControl control = null;
        try {
          Check(sessions.GetSession(index, out control));
          var control2 = (IAudioSessionControl2)control;
          int state; uint processId; string sessionId;
          Check(control2.GetState(out state));
          Check(control2.GetProcessId(out processId));
          Check(control2.GetSessionInstanceIdentifier(out sessionId));
          var volume = (ISimpleAudioVolume)control;
          result.Add(new SessionRef { DeviceId = deviceId, SessionId = sessionId, ProcessId = processId,
            Control = control, Control2 = control2, Volume = volume, State = state });
          control = null;
        } catch { if (control != null && Marshal.IsComObject(control)) Marshal.ReleaseComObject(control); }
      }
      return result;
    } finally {
      if (Marshal.IsComObject(sessions)) Marshal.ReleaseComObject(sessions);
      if (Marshal.IsComObject(manager)) Marshal.ReleaseComObject(manager);
    }
  }

  private static List<SessionRef> GetDefaultOutputSessions(IMMDeviceEnumerator enumerator, out string deviceId) {
    IMMDevice device;
    Check(enumerator.GetDefaultAudioEndpoint(0, 1, out device));
    try {
      Check(device.GetId(out deviceId));
      return GetSessions(enumerator, device, deviceId);
    } finally { if (Marshal.IsComObject(device)) Marshal.ReleaseComObject(device); }
  }

  public static object Duck(int rootProcessId, double factor) {
    if (factor <= 0 || factor > 1 || rootProcessId <= 0) throw new ArgumentOutOfRangeException();
    var owned = GetOwnedProcessIds((uint)rootProcessId);
    var enumerator = CreateEnumerator();
    var changed = new List<Dictionary<string, object>>();
    int failures = 0;
    try {
      string deviceId;
      var sessions = GetDefaultOutputSessions(enumerator, out deviceId);
      foreach (var session in sessions) {
        try {
          if (session.State != 1 || session.ProcessId == InvalidProcessId || owned.Contains(session.ProcessId)) continue;
          bool muted; float original;
          Check(session.Volume.GetMute(out muted));
          Check(session.Volume.GetMasterVolume(out original));
          if (muted || original <= 0.0001f) continue;
          var ducked = (float)(original * factor);
          var snapshot = new Dictionary<string, object> { { "deviceId", session.DeviceId }, { "sessionId", session.SessionId },
            { "processId", (int)session.ProcessId }, { "originalVolume", (double)original }, { "duckedVolume", (double)ducked } };
          var context = Guid.Empty;
          try { Check(session.Volume.SetMasterVolume(ducked, ref context)); changed.Add(snapshot); }
          catch {
            failures++;
            try { float current; Check(session.Volume.GetMasterVolume(out current)); if (Math.Abs(current - ducked) <= 0.005f) Check(session.Volume.SetMasterVolume(original, ref context)); }
            catch { }
          }
        } catch { failures++; }
        finally { if (Marshal.IsComObject(session.Control)) Marshal.ReleaseComObject(session.Control); }
      }
      return new Dictionary<string, object> { { "sessions", changed.ToArray() }, { "failedSessions", failures } };
    } finally { if (Marshal.IsComObject(enumerator)) Marshal.ReleaseComObject(enumerator); }
  }

  public static object Restore(string[] deviceIds, string[] sessionIds, int[] processIds, double[] originals, double[] ducked) {
    if (deviceIds == null || sessionIds == null || processIds == null || originals == null || ducked == null
      || deviceIds.Length != sessionIds.Length || deviceIds.Length != processIds.Length
      || deviceIds.Length != originals.Length || deviceIds.Length != ducked.Length) throw new ArgumentException();
    var enumerator = CreateEnumerator();
    int restored = 0, skipped = 0, failures = 0;
    try {
      for (int index = 0; index < deviceIds.Length; index++) {
        IMMDevice device = null;
        try {
          Check(enumerator.GetDevice(deviceIds[index], out device));
          var sessions = GetSessions(enumerator, device, deviceIds[index]);
          var session = sessions.Find(item => item.ProcessId == (uint)processIds[index]
            && String.Equals(item.SessionId, sessionIds[index], StringComparison.Ordinal));
          foreach (var item in sessions) if (!Object.ReferenceEquals(item, session) && Marshal.IsComObject(item.Control)) Marshal.ReleaseComObject(item.Control);
          if (session == null) { skipped++; continue; }
          try {
            float current; Check(session.Volume.GetMasterVolume(out current));
            if (Math.Abs(current - (float)ducked[index]) > 0.005f) { skipped++; continue; }
            var context = Guid.Empty;
            Check(session.Volume.SetMasterVolume((float)originals[index], ref context)); restored++;
          } catch { failures++; }
          finally { if (Marshal.IsComObject(session.Control)) Marshal.ReleaseComObject(session.Control); }
        } catch { failures++; }
        finally { if (device != null && Marshal.IsComObject(device)) Marshal.ReleaseComObject(device); }
      }
      return new Dictionary<string, object> { { "restored", restored }, { "skipped", skipped }, { "failedSessions", failures } };
    } finally { if (Marshal.IsComObject(enumerator)) Marshal.ReleaseComObject(enumerator); }
  }
}
'@
$null = Add-Type -TypeDefinition $source -Language CSharp
$activeSnapshots = @()
try {
  while ($null -ne ($line = [Console]::In.ReadLine())) {
    $request = $line | ConvertFrom-Json
    try {
      if ($request.action -eq 'duck') {
        $result = [NexaCoreAudioDucking]::Duck([int]$request.rootProcessId, [double]$request.factor)
        $activeSnapshots = @($result.sessions)
        $reply = @{ requestId = [string]$request.requestId; ok = $true; sessions = $activeSnapshots; failedSessions = [int]$result.failedSessions }
        [Console]::Out.WriteLine((ConvertTo-Json -InputObject $reply -Depth 5 -Compress))
        [Console]::Out.Flush()
      } elseif ($request.action -eq 'restore') {
        $sessions = if ($activeSnapshots.Count -gt 0) { $activeSnapshots } else { @($request.sessions) }
        $result = [NexaCoreAudioDucking]::Restore(
          [string[]]@($sessions | ForEach-Object { [string]$_.deviceId }),
          [string[]]@($sessions | ForEach-Object { [string]$_.sessionId }),
          [int[]]@($sessions | ForEach-Object { [int]$_.processId }),
          [double[]]@($sessions | ForEach-Object { [double]$_.originalVolume }),
          [double[]]@($sessions | ForEach-Object { [double]$_.duckedVolume }))
        if ([int]$result.failedSessions -eq 0) { $activeSnapshots = @() }
        $reply = @{ requestId = [string]$request.requestId; ok = $true; restored = [int]$result.restored; skipped = [int]$result.skipped; failedSessions = [int]$result.failedSessions }
        [Console]::Out.WriteLine((ConvertTo-Json -InputObject $reply -Depth 5 -Compress))
        [Console]::Out.Flush()
        break
      } else { throw 'invalid_audio_duck_request' }
    } catch {
      $reply = @{ requestId = [string]$request.requestId; ok = $false; error = 'core_audio_operation_failed' }
      [Console]::Out.WriteLine((ConvertTo-Json -InputObject $reply -Depth 3 -Compress))
      [Console]::Out.Flush()
      if ($request.action -eq 'restore') { break }
    }
  }
} finally {
  if ($activeSnapshots.Count -gt 0) {
    try {
      [NexaCoreAudioDucking]::Restore(
        [string[]]@($activeSnapshots | ForEach-Object { [string]$_.deviceId }),
        [string[]]@($activeSnapshots | ForEach-Object { [string]$_.sessionId }),
        [int[]]@($activeSnapshots | ForEach-Object { [int]$_.processId }),
        [double[]]@($activeSnapshots | ForEach-Object { [double]$_.originalVolume }),
        [double[]]@($activeSnapshots | ForEach-Object { [double]$_.duckedVolume })) | Out-Null
    } catch { }
  }
}
`;
