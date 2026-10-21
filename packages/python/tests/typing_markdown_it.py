"""对可选适配入口检查已安装包的类型声明。"""

from markdown_it import MarkdownIt
from multimd_table import Options
from multimd_table.markdown_it import multimd_table_plugin

options: Options = {"rowspan": True, "multiline": True}
md = MarkdownIt("commonmark").enable("table").use(multimd_table_plugin, **options)
html: str = md.render("A|B\n-|-\nx|y")
