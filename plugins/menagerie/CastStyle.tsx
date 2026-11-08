import { castCss } from './keyframes.ts';
import { useFunHosts } from './menagerie.ts';

/**
 * The cast's exits and prop moves as one stylesheet. castCss writes it from parsed, bounded values only, and leaves
 * out any character whose motion doesn't validate, so nothing a model wrote reaches the page as CSS text.
 */
export function CastStyle() {
  const hosts = useFunHosts();
  const css = castCss(hosts);
  return css ? <style data-menagerie="">{css}</style> : null;
}
