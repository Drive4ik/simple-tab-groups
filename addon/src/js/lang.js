
const MSG_START = '__MSG_';
const MSG_END = '__';

const FORMAT_HTML = 'html';
const FORMAT_TEXT = 'text';
const FORMAT_SEPARATOR = ':';

const MSG_REGEXP = new RegExp(`(?:(${FORMAT_HTML}|${FORMAT_TEXT})${FORMAT_SEPARATOR}\\s*)?${MSG_START}(\\w+?)${MSG_END}`, 'gm');
const TAG_REGEXP = /(\s*)<\s*([a-z\-]+)\s*([^=>\s]+)?\s*>\s*(.*)\s*<\s*\/\s*\2\s*>/gm;
const SIMPLE_MARKDOWN = new Map([
    [/\*{3}([^*]+)\*{3}/gm, '<strong><i>$1</i></strong>'],
    [/\*{2}([^*]+)\*{2}/gm, '<strong>$1</strong>'],
    [/\*([^*]+)\*/gm, '<i>$1</i>'],
    [/_{2}([^_]+)_{2}/gm, '<u>$1</u>'],
    [/`{3}([^`]+)`{3}/gm, '<pre>$1</pre>'],
    [/`([^`]+)`/g, '<code>$1</code>'],
]);
const TRANSLATABLE_ATTRIBUTES = 'title placeholder alt aria-label value';

const PARAMS = new URL(import.meta.url).searchParams;

const PARAMS_FORMAT_HTML = !PARAMS.has(FORMAT_TEXT);

if (PARAMS.has('translate-page')) {
    translate(document.documentElement);
}

function replaceInternalMessages(message, data, extra) {
    return message.replace(MSG_REGEXP, (match, format, messageName) => {
        return Lang([messageName, ...(messageName in data ? [data[messageName]].flat() : [])], data, extra);
    });
}

function replaceMarkdown(message, extra) {
    for (const [mdRegExp, htmlReplacer] of SIMPLE_MARKDOWN) {
        const replacer = extra.html ? htmlReplacer : '$1';
        message = message.replace(mdRegExp, replacer);
    }

    return message;
}

function replaceTags(message, data, extra) {
    const spaceAfterTags = new Set;

    message = message.replace(TAG_REGEXP, (match, spacesBefore = '', tagName, keyName, content) => {
        tagName = tagName.toLowerCase();

        const globalTagData = data[tagName] ?? {};
        const namedTagData = globalTagData[keyName] ?? globalTagData;

        if ('hreftocontent' in namedTagData || 'hreftocontent' in globalTagData) {
            try {
                const tagURL = new URL(namedTagData.href);
                const hreftocontent = namedTagData.hreftocontent ?? globalTagData.hreftocontent;
                content = (hreftocontent || 'hostname pathname')
                    .trim()
                    .split(/\s+/)
                    .map(k => tagURL[k])
                    .filter(Boolean)
                    .shift() || namedTagData.href;
            } catch {
                content = namedTagData.href;
            }
        }

        if ('spacesaround' in namedTagData || 'spacesaround' in globalTagData) {
            spacesBefore = ' ';
            spaceAfterTags.add(tagName);
        }

        let attrs = '';

        for (let [attr, value] of Object.entries(namedTagData)) {
            if (['hreftocontent', 'spacesaround'].includes(attr)) {
                continue;
            }

            if (hasMessage(value)) {
                value = Lang(value, data, extra);
            }

            attrs += ` ${attr}="${escapeAttrValue(value)}"`;
        }

        if (!extra.html) {
            return spacesBefore + content;
        }

        return `${spacesBefore}<${tagName}${attrs}>${content}</${tagName}>`;
    });

    for (const tagName of spaceAfterTags) {
        message = message.replace(new RegExp(`(</${tagName}>)\\s*`, 'gm'), '$1 ');
    }

    return message;
}

function escapeAttrValue(str) {
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function hasMessage(str) {
    return new RegExp(MSG_REGEXP).test(str);
}

function getMessageFormat(str) {
    const [, format = PARAMS_FORMAT_HTML] = new RegExp(MSG_REGEXP).exec(str) ?? [];
    return format;
}

// data can be Object, or if Array - with lang substitutions
export default function Lang(messageName, data = {}, extra = {html: PARAMS_FORMAT_HTML}) {
    if (!messageName) {
        return messageName;
    }

    data ??= {};

    let translated,
        substitutions = [];

    if (typeof messageName === 'string') {
        if (hasMessage(messageName) || messageName.includes(' ')) {
            translated = messageName; // keep as is
        } else {
            if (Object.prototype.toString.call(data) !== '[object Object]') {
                substitutions = data;
                data = {};
            }

            translated = browser.i18n.getMessage(messageName, substitutions);
        }
    } else if (Array.isArray(messageName)) {
        [messageName, ...substitutions] = messageName;

        if (!messageName) {
            return messageName;
        }

        translated = browser.i18n.getMessage(String(messageName), substitutions);
    } else {
        translated = String(messageName);
    }

    if (!translated) {
        const FORMAT = extra.html ? FORMAT_HTML : FORMAT_TEXT;
        return `${FORMAT + FORMAT_SEPARATOR}${MSG_START}${messageName}${MSG_END}`;
    }

    translated = replaceInternalMessages(translated, data, extra);
    translated = replaceMarkdown(translated, extra);
    translated = replaceTags(translated, data, extra);

    return translated;
}

export function translate(node) {
    if (!(node instanceof Element)) {
        throw Error('Only HTML nodes are supported!');
    }

    // translate messages into node text
    translateNodes(node);

    // translate messages into node attributes
    translateAttributes(node);
}

function translateNodes(parentElement) {
    const walker = document.createTreeWalker(parentElement, NodeFilter.SHOW_TEXT);
    const messageNodes = [];

    while (walker.nextNode()) {
        if (hasMessage(walker.currentNode.nodeValue)) {
            messageNodes.push(walker.currentNode);
        }
    }

    for (const node of messageNodes) {
        const parent = node.parentElement;
        const data = parent._stg_data ??= getNodeData(parent);

        const html = getMessageFormat(node.nodeValue) === FORMAT_HTML;

        const translated = Lang(node.nodeValue.trim(), data, {html});

        if (html) {
            node.replaceWith(document.createRange().createContextualFragment(translated));
        } else {
            node.nodeValue = translated;
        }
    }
}

function translateAttributes(parentElement) {
    const attrSelector = TRANSLATABLE_ATTRIBUTES
        .split(' ')
        .map(attr => `[${attr}^="${MSG_START}"]`)
        .join(',');

    for (const node of parentElement.querySelectorAll(attrSelector)) {
        for (const attr of node.attributes) {
            if (hasMessage(attr.value)) {
                attr.value = Lang(attr.value, node._stg_data);
            }
        }
    }
}

function getNodeData(node, data = {}) {
    for (const attr of node.attributes) {
        if (attr.name.startsWith('data-')) {
            attr.name.split('-').slice(1).reduce((obj, key, index, self) => {
                if (index < self.length - 1) {
                    return obj[key] ??= {};
                }

                obj[key] = attr.value;
            }, data);
        }
    }

    return data;
}
