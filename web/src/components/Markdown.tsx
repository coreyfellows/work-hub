import { useMemo } from 'react';
import ReactMarkdown, { type Components, type Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useSlot } from '../slots.ts';

/**
 * react-markdown with GitHub-flavoured Markdown, plus the `markdown-override` slot: plugins replace how an element
 * renders (`pre` for runnable commands, `code`/`p`/`li`/`td` for file links…) everywhere Markdown is drawn. The
 * `components` you pass are the defaults; slot items go on top, later contributions winning.
 */
export function Markdown({ children, components, remarkPlugins, ...rest }: Options & { children?: string | null }) {
  const overrides = useSlot('markdown-override');
  const merged = useMemo(() => {
    const out: Components = { ...components };
    for (const o of overrides) (out as Record<string, unknown>)[o.tag] = o.component;
    return out;
  }, [components, overrides]);
  return (
    <ReactMarkdown {...rest} remarkPlugins={[remarkGfm, ...(remarkPlugins ?? [])]} components={merged}>
      {children}
    </ReactMarkdown>
  );
}

/** Text content of a hast node (react-markdown passes the parsed `node` to component overrides). */
export function hastText(n: unknown): string {
  const node = n as { type?: string; value?: string; children?: unknown[] } | undefined;
  if (!node) return '';
  if (node.type === 'text') return node.value ?? '';
  return (node.children ?? []).map(hastText).join('');
}
