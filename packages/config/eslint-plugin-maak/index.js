/**
 * Custom ESLint rules that encode Maak's architecture.
 *
 * These are the rules that keep maintenance cheap: if they pass, the boundaries that make
 * this codebase safe (and bilingual) are intact. They are intentionally simple and
 * dependency-free — no type information required, so linting stays fast.
 */

const FRAMEWORK_IMPORTS = ['react', 'react-dom', 'react-native', 'next', 'expo', 'expo-router', '@supabase'];
const PHYSICAL_CSS = [
  { pattern: /\bmargin-(left|right)\b/, logical: 'margin-inline-start/end' },
  { pattern: /\bpadding-(left|right)\b/, logical: 'padding-inline-start/end' },
  { pattern: /\bborder-(left|right)\b/, logical: 'border-inline-start/end' },
  { pattern: /\btext-align\s*:\s*(left|right)\b/, logical: 'text-align: start/end' },
  { pattern: /\b(left|right)\s*:\s*-?\d/, logical: 'inset-inline-start/end' },
  { pattern: /\b(float|clear)\s*:\s*(left|right)\b/, logical: 'logical flow (no float)' },
];
const ARABIC = /[\u0600-\u06FF]/;
const LATIN_WORD = /[A-Za-z]{3,}/;

function isFramework(name) {
  return FRAMEWORK_IMPORTS.some((pkg) => name === pkg || name.startsWith(`${pkg}/`));
}

const coreIsFrameworkFree = {
  meta: {
    type: 'problem',
    docs: { description: 'packages/core must stay framework-free so it runs on web, native, edge and tests.' },
    schema: [],
    messages: {
      forbidden: "'{{name}}' must not be imported in packages/core — keep it pure TypeScript.",
    },
  },
  create(context) {
    const filename = context.filename.replace(/\\/g, '/');
    if (!filename.includes('packages/core/')) return {};
    return {
      ImportDeclaration(node) {
        const name = node.source.value;
        if (typeof name === 'string' && isFramework(name)) {
          context.report({ node, messageId: 'forbidden', data: { name } });
        }
      },
      ExportNamedDeclaration(node) {
        const name = node.source?.value;
        if (typeof name === 'string' && isFramework(name)) {
          context.report({ node, messageId: 'forbidden', data: { name } });
        }
      },
    };
  },
};

const noPhysicalDirection = {
  meta: {
    type: 'problem',
    docs: { description: 'Use CSS logical properties so RTL and LTR cost nothing to maintain.' },
    schema: [],
    messages: { physical: "'{{found}}' is direction-specific — use {{logical}}." },
  },
  create(context) {
    function check(node, text) {
      for (const rule of PHYSICAL_CSS) {
        const match = text.match(rule.pattern);
        if (match) {
          context.report({ node, messageId: 'physical', data: { found: match[0], logical: rule.logical } });
          return;
        }
      }
    }
    return {
      JSXAttribute(node) {
        if (node.name?.name !== 'style') return;
        check(node, context.sourceCode.getText(node));
      },
      Property(node) {
        const key = node.key?.name ?? node.key?.value;
        if (typeof key !== 'string') return;
        if (['marginLeft', 'marginRight', 'paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth', 'left', 'right'].includes(key)) {
          context.report({
            node,
            messageId: 'physical',
            data: { found: key, logical: 'the direction-aware equivalent (start/end)' },
          });
        }
      },
    };
  },
};

const noHardcodedCopy = {
  meta: {
    type: 'problem',
    docs: { description: 'All user-facing copy must come from the i18n dictionaries (BR-43).' },
    schema: [{ type: 'object', properties: { ignore: { type: 'array', items: { type: 'string' } } }, additionalProperties: false }],
    messages: { hardcoded: "Hardcoded copy '{{text}}' — add a key to packages/core/src/i18n/dictionaries.ts." },
  },
  create(context) {
    const filename = context.filename.replace(/\\/g, '/');
    if (
      filename.includes('/i18n/') ||
      filename.includes('/tests/') ||
      filename.includes('.test.') ||
      filename.includes('/scripts/') ||
      filename.includes('/supabase/')
    ) {
      return {};
    }

    function suspicious(value) {
      if (typeof value !== 'string') return false;
      if (ARABIC.test(value)) return true;
      // latin words of 3+ chars, but not identifiers, urls, css classes or keys
      if (!LATIN_WORD.test(value)) return false;
      if (/^[\w.:/@-]+$/.test(value)) return false;
      return value.trim().split(/\s+/).length >= 2;
    }

    function report(node, value) {
      context.report({ node, messageId: 'hardcoded', data: { text: value.slice(0, 40) } });
    }

    return {
      JSXText(node) {
        const value = node.value.trim();
        if (value && suspicious(value)) report(node, value);
      },
      JSXAttribute(node) {
        const name = node.name?.name;
        if (!['aria-label', 'placeholder', 'title', 'alt', 'label'].includes(name)) return;
        if (node.value?.type === 'Literal' && suspicious(node.value.value)) report(node, String(node.value.value));
        if (node.value?.type === 'JSXExpressionContainer' && node.value.expression?.type === 'Literal') {
          if (suspicious(node.value.expression.value)) report(node, String(node.value.expression.value));
        }
      },
      CallExpression(node) {
        // alert('...') / confirm('...') bypass the toast + i18n system entirely
        const callee = node.callee?.name;
        if (['alert', 'confirm', 'prompt'].includes(callee)) {
          context.report({ node, messageId: 'hardcoded', data: { text: callee } });
        }
      },
    };
  },
};

const singleWritePerHandler = {
  meta: {
    type: 'problem',
    docs: { description: 'One command = one transaction. More than one rpc() call risks a partial commit (ADR-18).' },
    schema: [],
    messages: {
      multiple: 'This handler makes {{count}} rpc() calls. Bundle the writes into a single cmd_* call.',
    },
  },
  create(context) {
    const filename = context.filename.replace(/\\/g, '/');
    if (!filename.includes('supabase/functions/') || filename.includes('/_shared/')) return {};
    const calls = [];
    return {
      CallExpression(node) {
        const callee = node.callee;
        const text = context.sourceCode.getText(callee);
        if (/\.rpc$/.test(text)) calls.push(node);
      },
      'Program:exit'() {
        if (calls.length > 1) {
          for (const node of calls) {
            context.report({ node, messageId: 'multiple', data: { count: calls.length } });
          }
        }
      },
    };
  },
};

const plugin = {
  meta: { name: 'eslint-plugin-maak', version: '0.1.0' },
  rules: {
    'core-is-framework-free': coreIsFrameworkFree,
    'no-physical-direction': noPhysicalDirection,
    'no-hardcoded-copy': noHardcodedCopy,
    'single-write-per-handler': singleWritePerHandler,
  },
};

export default plugin;
