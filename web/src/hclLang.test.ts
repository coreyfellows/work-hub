import assert from 'node:assert/strict';
import { test } from 'node:test';
import hljs from 'highlight.js/lib/core';
import hcl from './hclLang.ts';

hljs.registerLanguage('hcl', hcl);
const html = (src: string) => hljs.highlight(src, { language: 'hcl', ignoreIllegals: true }).value;

const SRC = `# routes
resource "cloudflare_worker_route" "domains" {
  for_each    = { for d in local.domains : d.domain => d }
  pattern     = "\${each.value.domain}/*"
  script_name = lookup(each.value, "script_name", "site-live")
  enabled     = true
  count       = 3
}
`;

test('hcl: block types, attributes, strings with interpolation, calls, literals, comments', () => {
  const out = html(SRC);
  assert.match(out, /<span class="hljs-comment"># routes<\/span>/);
  assert.match(out, /<span class="hljs-keyword">resource<\/span>/);
  assert.match(out, /<span class="hljs-string">&quot;cloudflare_worker_route&quot;<\/span>/);
  assert.match(out, /<span class="hljs-attr">script_name<\/span>/);
  assert.match(out, /<span class="hljs-subst">\$\{<span class="hljs-variable">each.value.domain<\/span>\}<\/span>/);
  assert.match(out, /<span class="hljs-title function_">lookup<\/span>/);
  assert.match(out, /<span class="hljs-literal">true<\/span>/);
  assert.match(out, /<span class="hljs-number">3<\/span>/);
  assert.match(out, /<span class="hljs-keyword">for<\/span>/);
});

test('hcl: heredocs are strings, with interpolation', () => {
  const out = html('locals {\n  doc = <<-EOT\n    hi ${var.name}\n  EOT\n}\n');
  assert.match(out, /<span class="hljs-string">&lt;&lt;-EOT[\s\S]*<span class="hljs-subst">\$\{<span class="hljs-variable">var.name<\/span>\}<\/span>[\s\S]*EOT<\/span>/);
});

test('hcl: a for expression\'s key => value is not an attribute', () => {
  assert.doesNotMatch(html('x = { for d in xs : d => d }\n'), /hljs-attr">d</);
});
