let nativeProcessSnapshot;

async function getWindowsProcesses() {
    if (!nativeProcessSnapshot) {
        nativeProcessSnapshot = (async () => {
            const { default: koffi } = await import('koffi');
            const kernel32 = koffi.load('kernel32.dll');
            const ProcessEntry32 = koffi.struct('NexaProcessEntry32W', {
                dwSize: 'uint32',
                cntUsage: 'uint32',
                th32ProcessID: 'uint32',
                th32DefaultHeapID: 'uintptr_t',
                th32ModuleID: 'uint32',
                cntThreads: 'uint32',
                th32ParentProcessID: 'uint32',
                pcPriClassBase: 'int32',
                dwFlags: 'uint32',
                szExeFile: koffi.array('char16_t', 260),
            });
            const createSnapshot = kernel32.func(
                '__stdcall', 'CreateToolhelp32Snapshot', 'void *', ['uint32', 'uint32']
            );
            const processFirst = kernel32.func(
                '__stdcall', 'Process32FirstW', 'int32_t', [
                    'void *', koffi.inout(koffi.pointer(ProcessEntry32)),
                ]
            );
            const processNext = kernel32.func(
                '__stdcall', 'Process32NextW', 'int32_t', [
                    'void *', koffi.inout(koffi.pointer(ProcessEntry32)),
                ]
            );
            const closeHandle = kernel32.func('__stdcall', 'CloseHandle', 'int32_t', ['void *']);
            return () => {
                const snapshot = createSnapshot(0x00000002, 0);
                const invalidHandle = (1n << BigInt(koffi.sizeof('void *') * 8)) - 1n;
                if (!snapshot || BigInt(snapshot) === invalidHandle) {
                    throw new Error('CreateToolhelp32Snapshot failed');
                }

                const processes = [];
                const entry = {
                    dwSize: koffi.sizeof(ProcessEntry32),
                    cntUsage: 0,
                    th32ProcessID: 0,
                    th32DefaultHeapID: 0,
                    th32ModuleID: 0,
                    cntThreads: 0,
                    th32ParentProcessID: 0,
                    pcPriClassBase: 0,
                    dwFlags: 0,
                    szExeFile: '',
                };
                try {
                    let hasEntry = processFirst(snapshot, entry);
                    while (hasEntry) {
                        if (entry.th32ProcessID > 0 && entry.szExeFile) {
                            processes.push({
                                name: entry.szExeFile,
                                pid: entry.th32ProcessID,
                            });
                        }
                        hasEntry = processNext(snapshot, entry);
                    }
                    return processes;
                } finally {
                    closeHandle(snapshot);
                }
            };
        })();
    }
    const snapshotProcesses = await nativeProcessSnapshot;
    return snapshotProcesses();
}

function parseCsvRow(line) {
    const fields = [];
    let field = '';
    let insideQuotes = false;

    for (let index = 0; index < line.length; index += 1) {
        const character = line[index];
        if (character === '"') {
            if (insideQuotes && line[index + 1] === '"') {
                field += '"';
                index += 1;
            } else {
                insideQuotes = !insideQuotes;
            }
        } else if (character === ',' && !insideQuotes) {
            fields.push(field);
            field = '';
        } else {
            field += character;
        }
    }
    fields.push(field);
    return fields;
}

export function parseWindowsTaskList(output) {
    return output
        .split(/\r?\n/u)
        .filter(line => line.trim())
        .map(parseCsvRow)
        .map(([name, rawPid]) => ({
            name: name?.replace(/^\uFEFF/u, ''),
            pid: Number(rawPid),
        }))
        .filter(processInfo =>
            typeof processInfo.name === 'string' &&
            processInfo.name.length > 0 &&
            Number.isSafeInteger(processInfo.pid) &&
            processInfo.pid > 0
        );
}

export async function listRunningProcesses({
    listProcesses,
    processSnapshot = getWindowsProcesses,
    platform = process.platform,
} = {}) {
    if (platform !== 'win32') {
        return {
            success: false,
            error: {
                code: 'unsupported_platform',
                message: 'La consulta de procesos solo está disponible en Windows.',
            },
        };
    }

    try {
        const processes = listProcesses
            ? parseWindowsTaskList(await listProcesses())
            : await processSnapshot();
        return { success: true, processes };
    } catch {
        return {
            success: false,
            error: {
                code: 'process_list_failed',
                message: 'No se pudieron consultar los procesos de Windows.',
            },
        };
    }
}
