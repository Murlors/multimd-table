"""共享 HTML 契约和宿主边界；只在安装 markdown-it extra 的消费者中运行。"""

from html.parser import HTMLParser
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch

from markdown_it import MarkdownIt
from multimd_table import TableScanner
from multimd_table.markdown_it import multimd_table_plugin


class Fragment(HTMLParser):
    def __init__(self, source):
        super().__init__(convert_charrefs=True)
        self.tree = []
        self.stack = [self.tree]
        self.pre = 0
        self.feed(source)

    def handle_starttag(self, tag, attrs):
        children = []
        self.stack[-1].append((tag, sorted(attrs), children))
        if tag not in ("br", "hr", "img", "input"):
            self.stack.append(children)
        self.pre += tag == "pre"

    def handle_endtag(self, tag):
        self.stack.pop()
        self.pre -= tag == "pre"

    def handle_data(self, data):
        value = data if self.pre else " ".join(data.split())
        if value:
            self.stack[-1].append(value)


def parser(**options):
    return MarkdownIt("commonmark").enable("table").use(multimd_table_plugin, **options)


class MarkdownItTests(unittest.TestCase):
    def test_shared_syntax_and_all_option_combinations(self):
        vectors = Path(os.environ["MULTIMD_VECTORS"]).with_name("adapters.json")
        for case in json.loads(vectors.read_text(encoding="utf-8")):
            with self.subTest(case=case["name"]):
                html = parser(**case.get("options", {})).render(case["source"])
                self.assertEqual(Fragment(html).tree, Fragment(case["html"]).tree)

    def test_host_rule_toggles_and_validation(self):
        source = "A|B\n-|-\nx||\n^^||"
        md = MarkdownIt("commonmark").use(multimd_table_plugin, rowspan=True)
        self.assertEqual(md.render(source), MarkdownIt("commonmark").render(source))
        self.assertIn('rowspan="2"', md.enable("table").render(source))
        self.assertNotIn("<table>", md.disable("table").render(source))
        with self.assertRaises(TypeError):
            parser(rowspan="yes")
        with self.assertRaises(TypeError):
            parser(unknown=True)

    def test_host_fences_code_and_rejected_candidates(self):
        md, base = parser(), MarkdownIt("commonmark").enable("table")
        for source in [
            "literal | pipe\n- list", "literal | pipe\n> quote", "literal | pipe\n# heading",
            "a|b\nc|d\n- list", "```md\nA|B\n-|-\nx|y\n```",
            "    A|B\n    -|-\n    x|y", "plain|literal",
            *[prefix + "\tA|B\n-|-\nx|y" for prefix in ("", " ", "  ", "   ")],
        ]:
            with self.subTest(source=source):
                self.assertEqual(md.render(source), base.render(source))
        html = md.render("A|B\n-|-\nx|y\n```md\noutside|pipe\n```\n\n# Heading")
        self.assertIn('<pre><code class="language-md">outside|pipe\n</code></pre>', html)
        self.assertIn("<h1>Heading</h1>", html)

    def test_references_and_parser_reuse(self):
        md = parser(multiline=True)
        html = md.render("A|B\n-|-\n|[late]|[cell]|\n|[cell]: /cell|[late]|\\\n| |[cell]|\n\nOutside [cell] [late]\n\n[late]: /later")
        self.assertEqual(html.count('href="/cell"'), 3)
        self.assertEqual(html.count('href="/later"'), 3)
        self.assertNotIn("[cell]:", html)
        self.assertIn("<td>[late]</td>", md.render("A|B\n-|-\n[late]|x"))

    def test_containers_unicode_maps_and_token_levels(self):
        source = "before\n\n> - list\n>\n>   [😀 title]\n>   A|B\n>   -|-\n>   - 😀 one|first|\\\n>   - two|second|\n>\n>   x|y\n\nafter"
        tokens = parser(multiline=True).parse(source)
        self.assertEqual(next(t.map for t in tokens if t.type == "table_open"), [4, 11])
        self.assertEqual(next(t.map for t in tokens if t.type == "caption_open"), [4, 5])
        self.assertEqual([t.map for t in tokens if t.type == "tbody_open"], [[7, 9], [10, 11]])
        self.assertEqual(next(t.map for t in tokens if t.type == "inline" and t.content == "😀 one"), [7, 8])
        level = 0
        for token in tokens:
            level -= token.nesting == -1
            self.assertEqual(token.level, level)
            level += token.nesting == 1
        self.assertEqual(level, 0)
        html = parser().render("A|B\n-|-\n😀|x\n[bottom]\n\nafter")
        self.assertIn("<td>😀</td>", html)
        self.assertIn("<p>after</p>", html)

    def test_renderer_overrides_and_core_plugins(self):
        md = parser(multiline=True)

        def render_cell(renderer, tokens, index, options, env):
            tokens[index].attrJoin("class", "host-cell")
            return renderer.renderToken(tokens, index, options, env)

        def transform(state):
            for token in state.tokens:
                if token.type == "inline":
                    for child in token.children or []:
                        if child.type == "text":
                            child.content = child.content.replace("before", "after")

        md.add_render_rule("td_open", render_cell)
        md.core.ruler.after("inline", "transform", transform)
        html = md.render("A|B\n-|-\n**bold**|before\n- one|before|\\\n- two|before|")
        self.assertEqual(html.count('class="host-cell"'), 4)
        self.assertIn("<strong>bold</strong>", html)
        self.assertIn("<li>one</li>", html)
        self.assertNotIn("before", html)

    def test_html_policy_belongs_to_host(self):
        source = 'A|B\n-|-\n<script>alert(1)</script>|[x](javascript:alert(1))'
        md = parser()
        md.options["html"] = False
        html = md.render(source)
        self.assertNotIn("<script>", html)
        self.assertNotIn('href="javascript:', html)
        self.assertIn("&lt;script&gt;", html)
        md.options["html"] = True
        self.assertIn("<script>", md.render(source))

    def test_scanners_dispose_on_rejection_and_host_exceptions(self):
        scanners = []

        def track(**options):
            scanner = TableScanner(**options)
            scanners.append(scanner)
            return scanner

        with patch("multimd_table.markdown_it.TableScanner", side_effect=track):
            md = parser(multiline=True)
            md.render("not|a\nvalid|table\nparagraph")
            md.render("A|B\n-|-\nx|y")
            original_parse = md.block.parse

            def explode(*args):
                raise RuntimeError("host block parser")

            # 仅嵌套块解析失败，外层文档仍走真实宿主流水线。
            def block_parse(source, markdown, env, tokens):
                with patch.object(md.block, "parse", side_effect=explode):
                    return original_parse(source, markdown, env, tokens)

            with patch.object(md.block, "parse", side_effect=block_parse):
                with self.assertRaisesRegex(RuntimeError, "host block parser"):
                    md.render("A|B\n-|-\n- one|x|\\\n- two|y|")
        self.assertTrue(scanners)
        self.assertTrue(all(scanner.disposed for scanner in scanners))
