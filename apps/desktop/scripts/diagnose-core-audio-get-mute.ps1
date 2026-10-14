param(
  [switch]$ValidateOnly,
  [ValidateSet('retained', 'released')][string]$Variant
)

$ErrorActionPreference = 'Stop'

# This probe only reads the multimedia render endpoint. Each variant runs in its
# own PowerShell process so a native COM failure cannot suppress the other result.
$source = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class NexaCoreAudioMuteProbe {
  private const int CLSCTX_ALL = 23;
  private static readonly Guid EnumeratorClass = new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E");
  private static readonly Guid SessionManagerId = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");

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
    [PreserveSig] int SetMasterVolume(float volume, ref Guid context);
    [PreserveSig] int GetMasterVolume(out float volume);
    [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool muted, ref Guid context);
    [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool muted);
  }

  private sealed class SessionRef {
    public IAudioSessionControl Control;
    public ISimpleAudioVolume Volume;
  }

  public sealed class ProbeResult {
    public string Status { get; set; }
    public string Stage { get; set; }
    public int HResult { get; set; }
    public int EnumeratedSessions { get; set; }
    public int SpotifySessions { get; set; }
    public int SkippedSessions { get; set; }
    public bool? Muted { get; set; }
    public bool VolumeRead { get; set; }
  }

  private static void Check(int hr) { if (hr < 0) Marshal.ThrowExceptionForHR(hr); }
  private static void Release(object value) {
    if (value != null && Marshal.IsComObject(value)) Marshal.ReleaseComObject(value);
  }
  private static void Enter(string variant, string stage) {
    Console.Out.WriteLine("{\"variant\":\"" + variant + "\",\"status\":\"entered\",\"stage\":\"" + stage + "\"}");
    Console.Out.Flush();
  }

  public static ProbeResult Inspect(string variant) {
    var result = new ProbeResult { Status = "error", Stage = "create_enumerator" };
    IMMDeviceEnumerator endpoints = null;
    IMMDevice device = null;
    IAudioSessionManager2 manager = null;
    IAudioSessionEnumerator enumerator = null;
    var spotify = new List<SessionRef>();
    try {
      var type = Type.GetTypeFromCLSID(EnumeratorClass, true);
      endpoints = (IMMDeviceEnumerator)Activator.CreateInstance(type);
      result.Stage = "default_endpoint";
      Check(endpoints.GetDefaultAudioEndpoint(0, 1, out device));
      string ignoredDeviceId;
      result.Stage = "device_id";
      Check(device.GetId(out ignoredDeviceId));
      result.Stage = "activate_manager";
      var iid = SessionManagerId;
      object managerObject;
      Check(device.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out managerObject));
      manager = (IAudioSessionManager2)managerObject;
      result.Stage = "get_session_enumerator";
      Check(manager.GetSessionEnumerator(out enumerator));
      int count;
      result.Stage = "get_session_count";
      Check(enumerator.GetCount(out count));
      result.EnumeratedSessions = count;
      for (int index = 0; index < count; index++) {
        IAudioSessionControl control = null;
        try {
          result.Stage = "get_session";
          Check(enumerator.GetSession(index, out control));
          result.Stage = "query_session_control";
          var control2 = (IAudioSessionControl2)control;
          int state;
          uint processId;
          string ignoredSessionId;
          result.Stage = "get_session_state";
          Check(control2.GetState(out state));
          result.Stage = "get_process_id";
          Check(control2.GetProcessId(out processId));
          result.Stage = "get_session_identifier";
          Check(control2.GetSessionInstanceIdentifier(out ignoredSessionId));
          result.Stage = "query_simple_audio_volume";
          var volume = (ISimpleAudioVolume)control;
          if (state != 1 || processId == 0) continue;
          bool isSpotify = false;
          try {
            using (var process = Process.GetProcessById((int)processId))
              isSpotify = String.Equals(process.ProcessName, "spotify", StringComparison.OrdinalIgnoreCase);
          } catch (Exception) { /* A session can outlive its process. */ }
          if (!isSpotify) continue;
          spotify.Add(new SessionRef { Control = control, Volume = volume });
          control = null;
        } catch (Exception) {
          result.SkippedSessions++;
        } finally { Release(control); }
      }
      result.Stage = "spotify_resolution";
      result.SpotifySessions = spotify.Count;
      if (spotify.Count == 0) { result.Status = "spotify_absent"; return result; }
      if (spotify.Count > 1) { result.Status = "ambiguous_sessions"; return result; }
      if (variant == "released") {
        // Match production: release containers after enumeration, retain the session RCW.
        result.Stage = "release_containers";
        Enter(variant, result.Stage);
        Release(enumerator); enumerator = null;
        Release(manager); manager = null;
        Release(device); device = null;
      }
      bool muted;
      result.Stage = "get_mute";
      Enter(variant, result.Stage);
      Check(spotify[0].Volume.GetMute(out muted));
      result.Muted = muted;
      float level;
      result.Stage = "get_session_volume";
      Enter(variant, result.Stage);
      Check(spotify[0].Volume.GetMasterVolume(out level));
      result.VolumeRead = true;
      result.Stage = "complete";
      result.Status = "ok";
    } catch (Exception error) {
      result.HResult = error.HResult;
    } finally {
      foreach (var session in spotify) Release(session.Control);
      Release(enumerator);
      Release(manager);
      Release(device);
      Release(endpoints);
    }
    return result;
  }
}
'@

if ($ValidateOnly -or $Variant) {
  try { $null = Add-Type -TypeDefinition $source -Language CSharp -ErrorAction Stop }
  catch {
    [pscustomobject]@{ variant = $Variant; status = 'compile_error'; hresult = [int]$_.Exception.HResult } | ConvertTo-Json -Compress
    exit 2
  }
  if ($ValidateOnly) { '{"status":"compile_ok"}'; exit 0 }
  try {
    $result = [NexaCoreAudioMuteProbe]::Inspect($Variant)
    [pscustomobject]@{ variant = $Variant; status = $result.Status; stage = $result.Stage;
      hresult = $result.HResult; enumeratedSessions = $result.EnumeratedSessions;
      spotifySessions = $result.SpotifySessions; skippedSessions = $result.SkippedSessions;
      muted = $result.Muted; volumeRead = $result.VolumeRead } | ConvertTo-Json -Compress
  } catch {
    [pscustomobject]@{ variant = $Variant; status = 'probe_error'; hresult = [int]$_.Exception.HResult } | ConvertTo-Json -Compress
    exit 3
  }
  exit 0
}

foreach ($mode in @('retained', 'released')) {
  $start = New-Object System.Diagnostics.ProcessStartInfo
  $start.FileName = Join-Path $PSHOME 'powershell.exe'
  $start.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -Variant ' + $mode
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $process = [System.Diagnostics.Process]::Start($start)
  $outputTask = $process.StandardOutput.ReadToEndAsync()
  $errorTask = $process.StandardError.ReadToEndAsync()
  $finished = $process.WaitForExit(30000)
  if (-not $finished) { $process.Kill(); $process.WaitForExit() }
  $output = $outputTask.Result
  $null = $errorTask.Result
  $lastStage = 'startup'
  $reported = $false
  foreach ($line in ($output -split "`r?`n")) {
    try { $item = ConvertFrom-Json -InputObject $line -ErrorAction Stop } catch { continue }
    if ($item.variant -ne $mode) { continue }
    if ($item.status -eq 'entered' -and $item.stage -in @('release_containers', 'get_mute', 'get_session_volume')) {
      $lastStage = $item.stage
      continue
    }
    if ($item.status -notin @('ok', 'error', 'spotify_absent', 'ambiguous_sessions', 'probe_error', 'compile_error')) { continue }
    [pscustomobject]@{ variant = $mode; status = $item.status; stage = $item.stage;
      hresult = $item.hresult; enumeratedSessions = $item.enumeratedSessions;
      spotifySessions = $item.spotifySessions; skippedSessions = $item.skippedSessions;
      muted = $item.muted; volumeRead = $item.volumeRead } | ConvertTo-Json -Compress
    $reported = $true
  }
  if (-not $reported) {
    [pscustomobject]@{ variant = $mode; status = $(if ($finished) { 'native_exit' } else { 'timeout' });
      stage = $lastStage; exitCode = $process.ExitCode } | ConvertTo-Json -Compress
  }
  $process.Dispose()
}
