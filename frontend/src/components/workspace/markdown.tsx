'use client';

import React, { useState } from 'react';
import styles from '@/app/app/workspace.module.css';

export type BlockToken =
  | { type: 'codeblock'; lang: string; code: string }
  | { type: 'blockquote'; lines: string[] }
  | { type: 'paragraph'; text: string };

export type InlineToken =
  | { type: 'text'; value: string }
  | { type: 'code'; value: string }
  | { type: 'spoiler'; value: string }
  | { type: 'bold'; value: string }
  | { type: 'italic'; value: string }
  | { type: 'strike'; value: string }
  | { type: 'mention'; value: string }
  | { type: 'link'; href: string };

const SAFE_FALLBACK_COLORS = [
  '#1f6b3a',
  '#1d5e6e',
  '#8a5a19',
  '#2f4858',
  '#3b5d4f',
  '#7a3e26',
];

export function safeAvatarColor(rawColor: string | undefined, seed = ''): string {
  if (rawColor && /^#[0-9a-fA-F]{6}$/.test(rawColor)) {
    const r = parseInt(rawColor.slice(1, 3), 16);
    const g = parseInt(rawColor.slice(3, 5), 16);
    const b = parseInt(rawColor.slice(5, 7), 16);
    // Guard against violet/purple/indigo hues (high blue + moderate/high red, low green)
    const isVioletish = b > 140 && b > g + 35 && r > g + 15;
    if (!isVioletish) return rawColor;
  }
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return SAFE_FALLBACK_COLORS[hash % SAFE_FALLBACK_COLORS.length];
}

export function aliasInitials(alias: string): string {
  const parts = alias.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '??';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}

export function tokenizeBlocks(input: string): BlockToken[] {
  const blocks: BlockToken[] = [];
  const fenceRegex = /```([a-zA-Z0-9_-]*)\n?([\s\S]*?)```/g;
  let lastIdx = 0;
  let match: RegExpExecArray | null;

  const pushProse = (prose: string) => {
    if (!prose) return;
    const lines = prose.split('\n');
    let quoteAcc: string[] = [];
    let paraAcc: string[] = [];

    const flushQuote = () => {
      if (quoteAcc.length > 0) {
        blocks.push({ type: 'blockquote', lines: quoteAcc });
        quoteAcc = [];
      }
    };
    const flushPara = () => {
      if (paraAcc.length > 0) {
        const joined = paraAcc.join('\n');
        if (joined.trim().length > 0 || blocks.length > 0) {
          blocks.push({ type: 'paragraph', text: joined });
        }
        paraAcc = [];
      }
    };

    for (const line of lines) {
      if (line.startsWith('> ') || line === '>') {
        flushPara();
        quoteAcc.push(line.replace(/^>\s?/, ''));
      } else {
        flushQuote();
        paraAcc.push(line);
      }
    }
    flushQuote();
    flushPara();
  };

  while ((match = fenceRegex.exec(input)) !== null) {
    if (match.index > lastIdx) {
      pushProse(input.slice(lastIdx, match.index));
    }
    blocks.push({
      type: 'codeblock',
      lang: match[1] || 'code',
      code: match[2].replace(/\n$/, ''),
    });
    lastIdx = match.index + match[0].length;
  }

  if (lastIdx < input.length) {
    pushProse(input.slice(lastIdx));
  }

  return blocks;
}

export function tokenizeInline(
  text: string,
  knownAliases: string[] = []
): InlineToken[] {
  const tokens: InlineToken[] = [];
  const sortedAliases = [...knownAliases]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);

  let i = 0;
  let plain = '';

  const flushPlain = () => {
    if (plain) {
      tokens.push({ type: 'text', value: plain });
      plain = '';
    }
  };

  while (i < text.length) {
    const rest = text.slice(i);

    // Inline code `...`
    if (rest[0] === '`') {
      const end = rest.indexOf('`', 1);
      if (end > 1) {
        flushPlain();
        tokens.push({ type: 'code', value: rest.slice(1, end) });
        i += end + 1;
        continue;
      }
    }

    // Spoiler ||...||
    if (rest.startsWith('||')) {
      const end = rest.indexOf('||', 2);
      if (end > 2) {
        flushPlain();
        tokens.push({ type: 'spoiler', value: rest.slice(2, end) });
        i += end + 2;
        continue;
      }
    }

    // Bold **...**
    if (rest.startsWith('**')) {
      const end = rest.indexOf('**', 2);
      if (end > 2) {
        flushPlain();
        tokens.push({ type: 'bold', value: rest.slice(2, end) });
        i += end + 2;
        continue;
      }
    }

    // Strikethrough ~~...~~
    if (rest.startsWith('~~')) {
      const end = rest.indexOf('~~', 2);
      if (end > 2) {
        flushPlain();
        tokens.push({ type: 'strike', value: rest.slice(2, end) });
        i += end + 2;
        continue;
      }
    }

    // Italic *...*
    if (rest[0] === '*' && rest[1] !== '*' && rest[1] !== ' ') {
      const end = rest.indexOf('*', 1);
      if (end > 1 && !rest.slice(1, end).includes('\n')) {
        flushPlain();
        tokens.push({ type: 'italic', value: rest.slice(1, end) });
        i += end + 1;
        continue;
      }
    }

    // URL https://... or http://...
    if (rest.startsWith('https://') || rest.startsWith('http://')) {
      const urlMatch = /^https?:\/\/[^\s<]+/.exec(rest);
      if (urlMatch) {
        let url = urlMatch[0];
        while (/[.,!?;:)]$/.test(url)) {
          url = url.slice(0, -1);
        }
        flushPlain();
        tokens.push({ type: 'link', href: url });
        i += url.length;
        continue;
      }
    }

    // @alias or @here
    if (rest[0] === '@' && (i === 0 || /\s|\(/.test(text[i - 1]))) {
      const afterAt = rest.slice(1);
      let matchedAlias: string | null = null;
      if (/^here\b/i.test(afterAt)) {
        matchedAlias = afterAt.slice(0, 4);
      } else {
        for (const alias of sortedAliases) {
          if (
            afterAt.toLowerCase().startsWith(alias.toLowerCase()) &&
            (afterAt.length === alias.length ||
              /[\s.,!?;:)]/.test(afterAt[alias.length]))
          ) {
            matchedAlias = afterAt.slice(0, alias.length);
            break;
          }
        }
        if (!matchedAlias) {
          const fallbackWord = /^([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/.exec(afterAt);
          if (fallbackWord) {
            matchedAlias = fallbackWord[1];
          }
        }
      }

      if (matchedAlias) {
        flushPlain();
        tokens.push({ type: 'mention', value: `@${matchedAlias}` });
        i += 1 + matchedAlias.length;
        continue;
      }
    }

    plain += text[i];
    i += 1;
  }

  flushPlain();
  return tokens;
}

// Self-check on parser invariants in non-production builds (ponytail check rule)
if (process.env.NODE_ENV !== 'production') {
  const sample = tokenizeInline(
    'Hey @Cobalt Fox **ready** ||secret|| `gg`',
    ['Cobalt Fox']
  );
  const kinds = sample.map((t) => t.type).join(',');
  if (!kinds.includes('mention') || !kinds.includes('spoiler') || !kinds.includes('bold')) {
    throw new Error(`Markdown tokenizer self-check failed: ${kinds}`);
  }
}

function SpoilerPill({ text }: { text: string }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <button
      type="button"
      onClick={() => setRevealed((v) => !v)}
      className={`${styles.mdSpoiler} ${revealed ? styles.mdSpoilerRevealed : ''}`}
      aria-label={revealed ? 'Hide spoiler' : 'Reveal spoiler'}
      title={revealed ? 'Click to hide spoiler' : 'Click to reveal spoiler'}
    >
      {text}
    </button>
  );
}

function CodeFence({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  };
  return (
    <div className={styles.mdCodeBlock}>
      <div className={styles.mdCodeHeader}>
        <span>{lang}</span>
        <button
          type="button"
          onClick={handleCopy}
          className={styles.mdCopyBtn}
          aria-label="Copy code block"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className={styles.mdPre}>
        <code>{code}</code>
      </pre>
    </div>
  );
}

function InlineStream({
  text,
  knownAliases,
}: {
  text: string;
  knownAliases: string[];
}) {
  const lines = text.split('\n');
  return (
    <>
      {lines.map((line, lineIdx) => {
        const tokens = tokenizeInline(line, knownAliases);
        return (
          <React.Fragment key={lineIdx}>
            {lineIdx > 0 && <br />}
            {tokens.map((tok, idx) => {
              switch (tok.type) {
                case 'code':
                  return (
                    <code key={idx} className={styles.mdCodeInline}>
                      {tok.value}
                    </code>
                  );
                case 'spoiler':
                  return <SpoilerPill key={idx} text={tok.value} />;
                case 'bold':
                  return <strong key={idx}>{tok.value}</strong>;
                case 'italic':
                  return <em key={idx}>{tok.value}</em>;
                case 'strike':
                  return <del key={idx}>{tok.value}</del>;
                case 'mention':
                  return (
                    <span key={idx} className={styles.mdMention}>
                      {tok.value}
                    </span>
                  );
                case 'link':
                  return (
                    <a
                      key={idx}
                      href={tok.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={styles.mdLink}
                    >
                      {tok.href}
                    </a>
                  );
                default:
                  return <React.Fragment key={idx}>{tok.value}</React.Fragment>;
              }
            })}
          </React.Fragment>
        );
      })}
    </>
  );
}

export function RichMarkdown({
  body,
  knownAliases = [],
}: {
  body: string;
  knownAliases?: string[];
}) {
  const blocks = tokenizeBlocks(body);
  return (
    <>
      {blocks.map((block, idx) => {
        if (block.type === 'codeblock') {
          return <CodeFence key={idx} lang={block.lang} code={block.code} />;
        }
        if (block.type === 'blockquote') {
          return (
            <blockquote key={idx} className={styles.mdBlockquote}>
              <InlineStream
                text={block.lines.join('\n')}
                knownAliases={knownAliases}
              />
            </blockquote>
          );
        }
        return (
          <div key={idx}>
            <InlineStream text={block.text} knownAliases={knownAliases} />
          </div>
        );
      })}
    </>
  );
}
