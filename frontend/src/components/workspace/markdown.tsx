'use client';

import React, { useState } from 'react';
import c from '@/app/app/chat.module.css';

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

function Spoiler({ text }: { text: string }) {
  const [shown, setShown] = useState(false);
  return (
    <button
      type="button"
      className={c.spoiler}
      aria-pressed={shown}
      aria-label={shown ? `Spoiler: ${text}. Hide it` : 'Spoiler. Show it'}
      onClick={() => setShown((v) => !v)}
    >
      <span>{text}</span>
    </button>
  );
}

function CodeFence({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={c.codeBlock}>
      <div>
        <span>{lang}</span>
        <button
          type="button"
          onClick={() =>
            navigator.clipboard?.writeText(code).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1600);
            })
          }
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre>
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
                    <code key={idx} className={c.codeIn}>
                      {tok.value}
                    </code>
                  );
                case 'spoiler':
                  return <Spoiler key={idx} text={tok.value} />;
                case 'bold':
                  return <strong key={idx}>{tok.value}</strong>;
                case 'italic':
                  return <em key={idx}>{tok.value}</em>;
                case 'strike':
                  return <del key={idx}>{tok.value}</del>;
                case 'mention':
                  return (
                    <span key={idx} className={c.mention}>
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
                      className={c.link}
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
            <blockquote key={idx} className={c.blockquote}>
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
