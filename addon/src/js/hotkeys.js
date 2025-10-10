// do not include constants, because hotkeys includes by content-script
const IS_MAC = (navigator.userAgentData?.platform || navigator.platform || '').toLowerCase().includes('mac');

const mapValue = value => [value, value];

export const NOT_SUPPORTED_CODE_KEYS = new Set([
    'Tab', 'CapsLock', 'Escape', 'Backspace', 'NumLock', 'OSLeft', 'OSRight',
]);

const FunctionalKeysRegExp = /^F([0-9]|1[0-2])$/;

const codeKeyMap = new Map([
    // digits
    ...Array.from({length: 10}, (n, i) => [`Digit${i}`, i]),
    ...Array.from({length: 10}, (n, i) => [`Numpad${i}`, i]),

    // Functional keys
    ...Array.from({length: 12}, (n, i) => `F${i + 1}`).map(mapValue),

    // alphabet
    ...Array.from({length: 26}, (n, i) => String.fromCharCode(i + 65)).map(char => [`Key${char}`, char]),

    ...['Home', 'End', 'PageUp', 'PageDown', 'Insert', 'Delete', 'Space', 'Comma', 'Period', 'Quote', 'Backquote', 'Semicolon', 'Slash', 'Backslash', 'Enter', 'Equal', 'Minus'].map(mapValue),

    ['NumpadEnter', 'Enter'],

    ['NumpadDecimal', 'Decimal'],
    ['NumpadSubtract', 'Subtract'],
    ['NumpadMultiply', 'Multiply'],
    ['NumpadDivide', 'Divide'],

    ['ArrowUp', 'Up'],
    ['ArrowDown', 'Down'],
    ['ArrowLeft', 'Left'],
    ['ArrowRight', 'Right'],

    ...['MediaPlayPause', 'MediaStop'].map(mapValue),
    ['MediaTrackNext', 'MediaNextTrack'],
    ['MediaTrackPrevious', 'MediaPrevTrack'],
]);

function normalizeEventKey({code}) {
    return codeKeyMap.get(code);
}

function isFuncKeyValue(value) {
    return FunctionalKeysRegExp.test(value);
}

export function isValidHotkeyEvent(event) {
    if (!event.ctrlKey && !event.altKey && !event.metaKey) {
        return isFuncKeyValue(event.code);
    }

    if (!normalizeEventKey(event)) {
        return false;
    }

    return true;
}

export function isValidHotkeyValue(value) {
    const parts = value.split('+');
    return (parts.length >= 2 && parts.every(key => key)) || isFuncKeyValue(value);
}

export function eventToHotkeyValue(event) {
    const valueParts = [];

    if (event.ctrlKey) {
        valueParts.push(IS_MAC ? 'MacCtrl' : 'Ctrl');
    }

    if (event.metaKey) {
        valueParts.push('Command');
    }

    if (event.altKey) {
        valueParts.push('Alt');
    }

    if (event.shiftKey) {
        valueParts.push('Shift');
    }

    const normalizedKey = normalizeEventKey(event);

    valueParts.push(normalizedKey || '');

    return valueParts.join('+');
}
