"use client";

import { useMemo, type ReactNode } from "react";

/**
 * 會議室用安全精簡 Markdown：禁 raw HTML、連結僅 http(s)、半截 fence／table 可串流。
 * 不提供 HTML 預覽 iframe（避免信任任意標記）。
 */

function cleanHref(raw: string): string {
  const t = raw.replace(/[),.;:!?，。；：！？]+$/g, "").trim();
  if (!t || t.includes("…") || t.includes("...")) return "";
  try {
    const u = new URL(t);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return u.toString();
  } catch {
    return "";
  }
}

function hostnameOfUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return u.hostname.replace(/^www\./i, "");
  } catch {
    return raw.replace(/^https?:\/\//i, "").split(/[/?#]/)[0] || raw;
  }
}

function SourceChip({ href, label }: { href: string; label?: string }) {
  const url = cleanHref(href);
  if (!url) {
    return <span>{label || href}</span>;
  }
  const text = label?.trim() || hostnameOfUrl(url);
  return (
    <a className="md-link" href={url} target="_blank" rel="noopener noreferrer">
      {text}
    </a>
  );
}

/** 剝離／顯示為純文字，不解析為 DOM */
function stripRawHtml(text: string): string {
  return text.replace(/<\/?[a-zA-Z][^>]*>/g, "");
}

function renderInline(text: string): ReactNode[] {
  const safe = stripRawHtml(text);
  const nodes: ReactNode[] = [];
  const re =
    /(\*\*\*[^*\n]+\*\*\*|\*\*[^*\n]+\*\*|(?<!\*)\*(?!\s)([^*\n]+?)(?<!\s)\*(?!\*)|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|https?:\/\/[^\s<>\[\]（）]+)/gi;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(safe))) {
    if (m.index > last) nodes.push(safe.slice(last, m.index));
    const token = m[0];
    if (token.startsWith("***") && token.endsWith("***")) {
      nodes.push(
        <strong key={`bi${key++}`}>
          <em>{token.slice(3, -3)}</em>
        </strong>,
      );
    } else if (token.startsWith("**") && token.endsWith("**")) {
      nodes.push(<strong key={`b${key++}`}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("*") && token.endsWith("*")) {
      nodes.push(<em key={`i${key++}`}>{token.slice(1, -1)}</em>);
    } else if (token.startsWith("`")) {
      nodes.push(
        <code key={`c${key++}`} className="inline">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("[")) {
      const lm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
      if (lm) nodes.push(<SourceChip key={`l${key++}`} label={lm[1]} href={lm[2]} />);
      else nodes.push(token);
    } else if (/^https?:\/\//i.test(token)) {
      nodes.push(<SourceChip key={`u${key++}`} href={token} />);
    } else {
      nodes.push(token);
    }
    last = m.index + token.length;
  }
  if (last < safe.length) nodes.push(safe.slice(last));
  return nodes;
}

function isTableSeparator(line: string) {
  return /^\s*\|?[\s:-]+\|[\s|:-]+\|?\s*$/.test(line);
}

function parseTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((c) => c.trim());
}

type MdBlock =
  | { type: "code"; lang: string; body: string; open?: boolean }
  | { type: "text"; body: string };

function splitMarkdownBlocks(content: string, streaming: boolean): MdBlock[] {
  const parts: MdBlock[] = [];
  let i = 0;
  while (i < content.length) {
    const fence = content.indexOf("```", i);
    if (fence < 0) {
      parts.push({ type: "text", body: content.slice(i) });
      break;
    }
    if (fence > i) parts.push({ type: "text", body: content.slice(i, fence) });
    const after = fence + 3;
    const nl = content.indexOf("\n", after);
    const lang = content.slice(after, nl < 0 ? content.length : nl).trim();
    const bodyStart = nl < 0 ? content.length : nl + 1;
    const close = content.indexOf("```", bodyStart);
    if (close < 0) {
      parts.push({ type: "code", lang, body: content.slice(bodyStart), open: streaming || undefined });
      break;
    }
    parts.push({ type: "code", lang, body: content.slice(bodyStart, close).replace(/\n$/, "") });
    i = close + 3;
    if (content[i] === "\n") i += 1;
  }
  if (parts.length === 0) parts.push({ type: "text", body: content });
  return parts;
}

function splitStableText(body: string, streaming: boolean): { stable: string; tail: string } {
  if (!streaming) return { stable: body, tail: "" };
  const lastNl = body.lastIndexOf("\n");
  if (lastNl < 0) return { stable: "", tail: body };
  // 只暫扣最後一行（可能還在打字）。不要把整段未完成表格／數字列藏起來，
  // 否則數字一多會像被截斷，串流結束又突然變成完整內容。
  return {
    stable: body.slice(0, lastNl + 1),
    tail: body.slice(lastNl + 1),
  };
}

function renderTextBlock(body: string, keyBase: number, streaming: boolean) {
  const { stable, tail } = splitStableText(body, streaming);
  const lines = stable.length ? stable.split("\n") : [];
  const out: ReactNode[] = [];
  let listItems: { ordered: boolean; text: string }[] = [];
  let listOrdered = false;
  let para: string[] = [];

  const flushPara = () => {
    if (!para.length) return;
    out.push(<p key={`p${keyBase}-${out.length}`}>{renderInline(para.join("\n"))}</p>);
    para = [];
  };
  const flushList = () => {
    if (!listItems.length) return;
    const Tag = listOrdered ? "ol" : "ul";
    out.push(
      <Tag key={`l${keyBase}-${out.length}`}>
        {listItems.map((item, i) => (
          <li key={i}>{renderInline(item.text)}</li>
        ))}
      </Tag>,
    );
    listItems = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    const bullet = /^[-*]\s+(.+)$/.exec(line);
    const numbered = /^(\d+)\.\s+(.+)$/.exec(line);
    const hr = /^(-{3,}|\*{3,}|_{3,})\s*$/.test(line);
    const tableStart = line.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1]);

    if (tableStart) {
      flushList();
      flushPara();
      const header = parseTableRow(line);
      i += 1;
      const rows: string[][] = [];
      while (i + 1 < lines.length && lines[i + 1].includes("|") && !isTableSeparator(lines[i + 1])) {
        i += 1;
        rows.push(parseTableRow(lines[i]));
      }
      out.push(
        <div className="md-table-wrap" key={`t${keyBase}-${out.length}`}>
          <table>
            <thead>
              <tr>
                {header.map((h, hi) => (
                  <th key={hi}>{renderInline(h)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, ri) => (
                <tr key={ri}>
                  {header.map((_, ci) => (
                    <td key={ci}>{renderInline(row[ci] ?? "")}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
    } else if (heading) {
      flushList();
      flushPara();
      const level = heading[1].length;
      const Tag = `h${level}` as "h1" | "h2" | "h3";
      out.push(<Tag key={`h${keyBase}-${out.length}`}>{renderInline(heading[2])}</Tag>);
    } else if (hr) {
      flushList();
      flushPara();
      out.push(<hr key={`hr${keyBase}-${out.length}`} />);
    } else if (bullet) {
      flushPara();
      if (listItems.length && listOrdered) flushList();
      listOrdered = false;
      listItems.push({ ordered: false, text: bullet[1] });
    } else if (numbered) {
      flushPara();
      if (listItems.length && !listOrdered) flushList();
      listOrdered = true;
      listItems.push({ ordered: true, text: numbered[2] });
    } else if (line.trim() === "") {
      flushList();
      flushPara();
    } else {
      flushList();
      para.push(line);
    }
  }
  flushList();
  flushPara();
  if (tail) {
    out.push(
      <p key={`tail${keyBase}`} className="md-stream-tail">
        {stripRawHtml(tail)}
      </p>,
    );
  }
  return out;
}

export default function SafeLightMarkdown({
  content,
  streaming,
}: {
  content: string;
  streaming?: boolean;
}) {
  const blocks = useMemo(() => splitMarkdownBlocks(content, Boolean(streaming)), [content, streaming]);

  if (!content) return null;

  return (
    <div className={`md strategy-md${streaming ? " is-streaming-md" : ""}`}>
      {blocks.map((b, i) => {
        if (b.type === "code") {
          return (
            <div className={`md-code${b.open ? " is-open" : ""}`} key={i}>
              <div className="md-code-head">
                <span>{b.lang || (b.open ? "code…" : "code")}</span>
              </div>
              <pre>
                <code>{b.body}</code>
              </pre>
            </div>
          );
        }
        return <div key={i}>{renderTextBlock(b.body, i, Boolean(streaming))}</div>;
      })}
    </div>
  );
}
