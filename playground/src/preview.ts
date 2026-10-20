/** srcdoc 配合空 sandbox：预览只展示内容，不能执行脚本、加载远程内容或导航。 */
export function previewDocument(html: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="color-scheme" content="light dark">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'">
<style>
:root{color-scheme:light dark;--ink:#25362d;--muted:#66766b;--line:#dce4dd;--tint:#edf3ed;--accent:#197763;--surface:#fff}
@media(prefers-color-scheme:dark){:root{--ink:#e2ece3;--muted:#a5b5a9;--line:#3a4a3f;--tint:#24372b;--accent:#a3d7b4;--surface:#1b241f}}
*{box-sizing:border-box}body{margin:0;padding:36px 28px;color:var(--ink);background:var(--surface);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow-wrap:anywhere}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums;margin:0 0 24px}caption{text-align:left;font-size:19px;font-weight:600;line-height:1.4;padding:0 0 20px;color:var(--ink)}caption[style*="bottom"]{padding:18px 0 0}
th,td{padding:12px 15px;border:1px solid var(--line);vertical-align:top;min-width:60px}th{background:var(--tint);font-weight:600;text-align:left}tbody+tbody{border-top:2px solid var(--muted)}td[rowspan]{background:var(--tint)}.extend{white-space:normal}
a{color:var(--accent);text-underline-offset:3px}code{font:13px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;background:var(--tint);padding:2px 4px;border-radius:3px}pre{white-space:pre-wrap;background:var(--tint);padding:14px}pre code{padding:0}td>:first-child,th>:first-child{margin-top:0}td>:last-child,th>:last-child{margin-bottom:0}p{margin:0 0 16px}ul,ol{padding-left:20px}img{display:none}::selection{background:var(--tint);color:var(--ink)}
.empty{padding:70px 8px;color:var(--muted);text-align:center}.empty strong{display:block;color:var(--ink);font-weight:500;font-size:17px;margin-bottom:8px}
@media(max-width:450px){body{padding:24px 16px}th,td{padding:10px 9px;font-size:13px}caption{font-size:17px}}
</style></head><body>${html || '<div class="empty"><strong>A little Markdown goes a long way.</strong>Type a table on the left, or load an example.</div>'}</body></html>`;
}
