import { useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import { get, Markdown, Modal, NewFileBody, usePersistedPick, useSource } from '../../plugin-api/web.ts';
import { blobLabel, parseBlobUrl, type BlobLink } from './blobUrl.ts';
import type { GithubData } from './types.ts';

/**
 * Links in Markdown (the `a` override, everywhere Markdown is drawn). A file link on the GitHub host gh uses
 * (`…/blob/<ref>/<path>#L10-L20`) opens the file in a modal, the linked lines marked, with "Open on GitHub ↗" beside
 * it; ⌘/Ctrl/Shift/middle click still opens GitHub. Any other absolute link opens in a new tab, as before.
 */
export function MarkdownLink({ node: _node, href, children, ...rest }: { node?: unknown; href?: string; children?: ReactNode }) {
  const host = useSource<GithubData>('github')?.data?.host?.toLowerCase();
  const link = host ? parseBlobUrl(href) : null;
  const [open, setOpen] = useState(false);
  const absolute = !!href && /^[a-z][a-z0-9+.-]*:/i.test(href);
  if (!link || link.host !== host) {
    return (
      <a {...rest} href={href} {...(absolute ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>
        {children}
      </a>
    );
  }
  const onClick = (e: MouseEvent) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // let the browser open GitHub
    e.preventDefault();
    e.stopPropagation();
    setOpen(true);
  };
  return (
    <>
      <a {...rest} href={href} target="_blank" rel="noopener noreferrer" className="gh-file-link" title="Open the file here (⌘-click: on GitHub)" onClick={onClick}>
        {children}
      </a>
      {open && <GithubFileModal link={link} href={href!} onClose={() => setOpen(false)} />}
    </>
  );
}

interface BlobFile {
  ref: string;
  path: string;
  size: number;
  truncated: boolean;
  binary: boolean;
  content: string;
}

function GithubFileModal({ link, href, onClose }: { link: BlobLink; href: string; onClose(): void }) {
  const [data, setData] = useState<BlobFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    get<BlobFile>(`/api/plugins/github/blob?url=${encodeURIComponent(href)}`)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [href]);
  const label = data ? { ref: data.ref, path: data.path } : blobLabel(link);
  const ref = /^[0-9a-f]{40}$/i.test(label.ref) ? label.ref.slice(0, 7) : label.ref;
  const lines = data?.content ? data.content.split('\n').length : 0;
  const range = link.lines && (link.lines.from === link.lines.to ? `line ${link.lines.from}` : `lines ${link.lines.from}–${link.lines.to}`);
  // Markdown files: Rendered or Source, the pick shared with the session file modal ('1' = Source). A link to lines
  // opens on Source, so the marked lines show.
  const isMd = /\.(md|markdown|mdx)$/i.test(label.path);
  const [mdSource, setMdSource] = usePersistedPick('wh.mdSource');
  const [picked, setPicked] = useState<boolean | null>(null);
  const source = picked ?? (!!link.lines || mdSource === '1');
  const pick = (v: boolean) => {
    setPicked(v);
    setMdSource(v ? '1' : null);
  };
  const onGithub = (
    <a className="gh-file-out" href={href} target="_blank" rel="noopener noreferrer">
      Open on GitHub ↗
    </a>
  );
  return (
    <Modal
      className="file-modal gh-file-modal"
      onClose={onClose}
      head={
        <span className="file-title">
          {label.path} <span className="muted">@ {ref}</span> <span className="muted">· {link.owner}/{link.repo}</span>
        </span>
      }
    >
      <div className="file-meta">
        {data && !data.binary && <span>{lines} lines</span>}
        {data && <span>{data.size < 10240 ? `${data.size} B` : `${Math.ceil(data.size / 1024)} KB`}</span>}
        {range && <span>{range}</span>}
        {data?.truncated && <span className="bad">showing the first 1 MB</span>}
        <span className="grow" />
        {isMd && data && !data.binary && (
          <span className="gh-view-toggle">
            <button type="button" className={source ? '' : 'on'} onClick={() => pick(false)}>
              Rendered
            </button>
            <button type="button" className={source ? 'on' : ''} onClick={() => pick(true)}>
              Source
            </button>
          </span>
        )}
        {onGithub}
      </div>
      {error ? (
        <div className="modal-empty bad">{error}</div>
      ) : !data ? (
        <div className="modal-empty muted">Loading…</div>
      ) : data.binary ? (
        <div className="modal-empty muted">Binary file ({Math.ceil(data.size / 1024)} KB), not shown.</div>
      ) : isMd && !source ? (
        <RenderedMarkdown content={data.content} />
      ) : (
        <NewFileBody edit={{ path: data.path }} content={data.content} highlight={link.lines} />
      )}
    </Modal>
  );
}

/** A Markdown file as a document: YAML front matter as a code block, raw HTML not rendered, links through the overrides. */
function RenderedMarkdown({ content }: { content: string }) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  return (
    <div className="h-md gh-file-md">
      {fm && <pre className="gh-frontmatter">{fm[1]}</pre>}
      <Markdown skipHtml>{fm ? content.slice(fm[0].length) : content}</Markdown>
    </div>
  );
}
