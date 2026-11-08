import { Children, useContext, useEffect, useReducer, useState, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { get, Modal, NewFileBody, post, SessionIdContext, usePersistedPick } from '../../../plugin-api/web.ts';
import { pathCandidates } from './paths.ts';

/**
 * File paths in a session's messages become links when they resolve to a real file the session may show (its cwd,
 * its workspace's worktrees; checked on the server, see fileView.ts). Click opens the file in a modal with line
 * numbers and syntax colours. Candidates are checked in small batches and remembered, so a path costs one request.
 */

interface Hit {
  path: string;
  line?: number;
}

// --- resolve cache: hits stay, misses are retried after a minute (the file may be created later) ---
const cache = new Map<string, { v: Hit | null; at: number }>();
const waiting = new Map<string, Set<string>>();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
const MISS_MS = 60_000;

function cached(sid: string, p: string): Hit | null | undefined {
  const e = cache.get(`${sid}\0${p}`);
  if (!e) return undefined;
  if (!e.v && Date.now() - e.at > MISS_MS) return undefined;
  return e.v;
}

function request(sid: string, paths: string[]): void {
  const need = paths.filter((p) => cached(sid, p) === undefined);
  if (!need.length) return;
  let set = waiting.get(sid);
  if (!set) waiting.set(sid, (set = new Set()));
  need.forEach((p) => set.add(p));
  timer ??= setTimeout(flush, 30);
}

function flush(): void {
  timer = null;
  const batches = [...waiting];
  waiting.clear();
  for (const [sid, set] of batches) {
    const paths = [...set];
    for (let i = 0; i < paths.length; i += 50) {
      const chunk = paths.slice(i, i + 50);
      post<{ files: Record<string, Hit | null> }>(`/api/sessions/${sid}/files/resolve`, { paths: chunk })
        .then((r) => chunk.forEach((p) => cache.set(`${sid}\0${p}`, { v: r.files[p] ?? null, at: Date.now() })))
        .catch(() => chunk.forEach((p) => cache.set(`${sid}\0${p}`, { v: null, at: Date.now() })))
        .finally(() => listeners.forEach((l) => l()));
    }
  }
}

function useResolver(paths: string[]): (p: string) => Hit | null {
  const sid = useContext(SessionIdContext);
  const [, bump] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    listeners.add(bump);
    return () => void listeners.delete(bump);
  }, []);
  const key = paths.join('\n');
  useEffect(() => {
    if (sid && paths.length) request(sid, paths);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sid, key]);
  return (p) => (sid ? cached(sid, p) ?? null : null);
}

/** Plain text with the paths that resolve to files made clickable. */
export function PathText({ text }: { text: string }) {
  const cands = pathCandidates(text);
  const paths = [...new Set(cands.map((c) => c[2]))];
  const resolve = useResolver(paths);
  const hits = cands.filter((c) => resolve(c[2]));
  if (!hits.length) return <>{text}</>;
  const out: ReactNode[] = [];
  let last = 0;
  for (const [a, b, t] of hits) {
    if (a > last) out.push(text.slice(last, a));
    out.push(<FileLink key={a} raw={t}>{t}</FileLink>);
    last = b;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}

/** Inline `code` in Markdown: a link when the whole span is a file path the session can show. */
export function PathCode({ text, ...rest }: { text: string } & React.HTMLAttributes<HTMLElement>) {
  const t = text.trim();
  const resolve = useResolver(pathCandidates(t).length === 1 && pathCandidates(t)[0]![2] === t ? [t] : []);
  const code = <code {...rest}>{text}</code>;
  return resolve(t) ? <FileLink raw={t}>{code}</FileLink> : code;
}

/** Markdown children: strings go through PathText. */
export function linkPaths(children: ReactNode): ReactNode {
  return Children.map(children, (c) => (typeof c === 'string' ? <PathText text={c} /> : c));
}

function FileLink({ raw, children }: { raw: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="file-link" title="Open file" onClick={(e) => { e.stopPropagation(); setOpen(true); }}>
        {children}
      </button>
      {open && <FileModal raw={raw} onClose={() => setOpen(false)} />}
    </>
  );
}

interface FileData {
  path: string;
  size: number;
  truncated: boolean;
  binary: boolean;
  content: string;
  line?: number;
}

function FileModal({ raw, onClose }: { raw: string; onClose: () => void }) {
  const sid = useContext(SessionIdContext);
  const [data, setData] = useState<FileData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    get<FileData>(`/api/sessions/${sid}/file?path=${encodeURIComponent(raw)}`)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [sid, raw]);
  const isMd = /\.(md|markdown|mdx)$/i.test(data?.path ?? raw);
  // Same localStorage key as before the plugin existed ('1' = Source).
  const [mdSource, setMdSource] = usePersistedPick('wh.mdSource');
  const source = mdSource === '1';
  const toggle = (v: boolean) => setMdSource(v ? '1' : null);
  const shown = (data?.path ?? raw).replace(/^\/Users\/[^/]+/, '~');
  const lines = data?.content ? data.content.split('\n').length : 0;
  return (
    <Modal className="file-modal" onClose={onClose} head={<span className="file-title">{shown}</span>}>
      {error ? (
        <div className="modal-empty cmd-error">{error}</div>
      ) : !data ? (
        <div className="modal-empty muted">Loading…</div>
      ) : data.binary ? (
        <div className="modal-empty muted">Binary file ({Math.ceil(data.size / 1024)} KB), not shown.</div>
      ) : (
        <>
          <div className="file-meta">
            <span>{lines} lines</span>
            <span>{data.size < 10240 ? `${data.size} B` : `${Math.ceil(data.size / 1024)} KB`}</span>
            {data.line && <span>mentioned at line {data.line}</span>}
            {data.truncated && <span className="cmd-error">showing the first 1 MB</span>}
            {isMd && (
              <span className="file-view-toggle">
                <button type="button" className={source ? '' : 'on'} onClick={() => toggle(false)}>Rendered</button>
                <button type="button" className={source ? 'on' : ''} onClick={() => toggle(true)}>Source</button>
              </span>
            )}
          </div>
          {isMd && !source ? <MarkdownBody content={data.content} /> : <NewFileBody edit={{ path: data.path }} content={data.content} />}
        </>
      )}
    </Modal>
  );
}

/** A Markdown file as a document. YAML front matter is shown as a code block; raw HTML is not rendered. */
function MarkdownBody({ content }: { content: string }) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  const body = fm ? content.slice(fm[0].length) : content;
  return (
    <div className="h-md file-md">
      {fm && <pre className="file-frontmatter">{fm[1]}</pre>}
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{ a: ({ node: _n, children, ...rest }) => <a {...rest} target="_blank" rel="noopener noreferrer">{children}</a> }}
      >
        {body}
      </Markdown>
    </div>
  );
}
