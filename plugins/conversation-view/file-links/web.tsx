import type { ReactNode } from 'react';
import { hastText, type WebPluginContext } from '../../../plugin-api/web.ts';
import { linkPaths, PathCode, PathText } from './FileLinks.tsx';
import './styles.css';

export default function register(ctx: WebPluginContext): void {
  // Linkify (core) hands the text between URLs to this slot; paths that resolve to files are drawn as links.
  ctx.contribute('inline-text', { render: (text, key) => <PathText key={key} text={text} /> });

  // Markdown in the conversation: inline code that is a file path, and paths in paragraphs, list items and table cells.
  ctx.contribute('markdown-override', {
    tag: 'code',
    component: function Code({ node, className, children, ...rest }: { node?: unknown; className?: string; children?: ReactNode }) {
      const text = hastText(node);
      if (!className && !text.includes('\n')) return <PathCode text={text} {...rest} />; // inline code
      return (
        <code className={className} {...rest}>
          {children}
        </code>
      );
    },
  });
  for (const tag of ['p', 'li', 'td'] as const) {
    const Tag = tag;
    ctx.contribute('markdown-override', {
      tag,
      component: ({ node: _node, children, ...rest }: { node?: unknown; children?: ReactNode }) => <Tag {...rest}>{linkPaths(children)}</Tag>,
    });
  }
}
