// Windows Shell Link headers are 0x4c bytes; LinkFlags are at offset 0x14.
const shellLinkHeaderSize = 0x4c;
const shellLinkClassId = 0x00021401;
const hasLinkTargetIdList = 0x00000001;
const hasLinkInfo = 0x00000002;
const linkInfoHasLocalBasePath = 0x00000001;
const hasName = 0x00000004;
const hasRelativePath = 0x00000008;
const hasWorkingDirectory = 0x00000010;
const hasArguments = 0x00000020;
const hasIconLocation = 0x00000040;
const isUnicode = 0x00000080;
const hasEnvironmentBlock = 0x00000200;
const environmentVariableBlockSignature = 0xa0000001;

function hasBytes(buffer, offset, length, end = buffer.length) {
    return Number.isSafeInteger(offset)
        && Number.isSafeInteger(length)
        && offset >= 0
        && length >= 0
        && offset + length <= end;
}

function readNullTerminated(buffer, offset, end, unicode) {
    const step = unicode ? 2 : 1;

    if (!hasBytes(buffer, offset, step, end)) {
        return '';
    }

    let endOffset = offset;
    while (hasBytes(buffer, endOffset, step, end)) {
        const value = unicode
            ? buffer.readUInt16LE(endOffset)
            : buffer[endOffset];
        if (value === 0) break;
        endOffset += step;
    }

    return buffer.subarray(offset, endOffset).toString(unicode ? 'utf16le' : 'latin1');
}

function readLinkInfoTarget(buffer, offset) {
    if (!hasBytes(buffer, offset, 0x1c)) {
        return null;
    }

    const size = buffer.readUInt32LE(offset);
    const headerSize = buffer.readUInt32LE(offset + 4);
    const flags = buffer.readUInt32LE(offset + 8);

    if (
        size < 0x1c ||
        !hasBytes(buffer, offset, size) ||
        headerSize < 0x1c ||
        headerSize > size ||
        !(flags & linkInfoHasLocalBasePath)
    ) {
        return null;
    }

    // LinkInfo stores offsets to LocalBasePath and CommonPathSuffix here.
    const localBaseOffset = buffer.readUInt32LE(offset + 16);
    const commonSuffixOffset = buffer.readUInt32LE(offset + 24);

    if (
        localBaseOffset === 0 ||
        commonSuffixOffset === 0 ||
        localBaseOffset >= size ||
        commonSuffixOffset >= size
    ) {
        return null;
    }

    let localBase = readNullTerminated(buffer, offset + localBaseOffset, offset + size, false);
    let commonSuffix = readNullTerminated(buffer, offset + commonSuffixOffset, offset + size, false);

    if (headerSize >= 0x24) {
        const unicodeBaseOffset = buffer.readUInt32LE(offset + 28);
        const unicodeSuffixOffset = buffer.readUInt32LE(offset + 32);

        if (unicodeBaseOffset > 0 && unicodeBaseOffset < size) {
            localBase = readNullTerminated(
                buffer,
                offset + unicodeBaseOffset,
                offset + size,
                true
            );
        }
        if (unicodeSuffixOffset > 0 && unicodeSuffixOffset < size) {
            commonSuffix = readNullTerminated(
                buffer,
                offset + unicodeSuffixOffset,
                offset + size,
                true
            );
        }
    }

    const combined = [localBase, commonSuffix].filter(Boolean).join('\\');
    return combined || null;
}

function readStringDataEnd(buffer, offset, flags) {
    const unicode = Boolean(flags & isUnicode);
    const stringFlags = [
        hasName,
        hasRelativePath,
        hasWorkingDirectory,
        hasArguments,
        hasIconLocation,
    ];

    for (const flag of stringFlags) {
        if (!(flags & flag)) continue;
        if (!hasBytes(buffer, offset, 2)) return null;

        const characters = buffer.readUInt16LE(offset);
        offset += 2;
        const byteLength = characters * (unicode ? 2 : 1);

        if (!hasBytes(buffer, offset, byteLength)) return null;
        offset += byteLength;
    }

    return offset;
}

function expandEnvironmentPath(value, environment) {
    const expanded = value.replace(/%([^%]+)%/gu, (match, name) => {
        const environmentKey = Object.keys(environment).find(
            key => key.toLowerCase() === name.toLowerCase()
        );
        return environmentKey ? environment[environmentKey] : match;
    });

    return /%[^%]+%/u.test(expanded) ? null : expanded;
}

function readEnvironmentTarget(buffer, offset, environment) {
    while (hasBytes(buffer, offset, 8)) {
        const blockSize = buffer.readUInt32LE(offset);
        if (blockSize === 0) return null;
        if (blockSize < 8 || !hasBytes(buffer, offset, blockSize)) return null;

        const signature = buffer.readUInt32LE(offset + 4);
        if (signature === environmentVariableBlockSignature && blockSize >= 0x314) {
            // TargetUnicode follows the 260-byte TargetAnsi field in this block.
            const unicodeOffset = offset + 8 + 260;
            const target = readNullTerminated(buffer, unicodeOffset, offset + blockSize, true);
            return target ? expandEnvironmentPath(target, environment) : null;
        }

        offset += blockSize;
    }

    return null;
}

export function resolveShortcutTarget(buffer, environment = process.env) {
    if (
        !Buffer.isBuffer(buffer) ||
        !hasBytes(buffer, 0, shellLinkHeaderSize) ||
        buffer.readUInt32LE(0) !== shellLinkHeaderSize ||
        buffer.readUInt32LE(4) !== shellLinkClassId
    ) {
        return null;
    }

    const flags = buffer.readUInt32LE(20);
    let offset = shellLinkHeaderSize;

    if (flags & hasLinkTargetIdList) {
        if (!hasBytes(buffer, offset, 2)) return null;
        const listSize = buffer.readUInt16LE(offset);
        offset += 2 + listSize;
        if (!hasBytes(buffer, offset, 0)) return null;
    }

    let target = null;
    if (flags & hasLinkInfo) {
        if (!hasBytes(buffer, offset, 4)) return null;
        const infoSize = buffer.readUInt32LE(offset);
        target = readLinkInfoTarget(buffer, offset);
        if (infoSize < 4 || !hasBytes(buffer, offset, infoSize)) return null;
        offset += infoSize;
    }

    const stringDataEnd = readStringDataEnd(buffer, offset, flags);
    if (stringDataEnd === null) return target;

    const environmentTarget = flags & hasEnvironmentBlock
        ? readEnvironmentTarget(buffer, stringDataEnd, environment)
        : null;

    return environmentTarget ?? target;
}
