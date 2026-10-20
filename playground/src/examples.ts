import type { Options } from "multimd-table-release";

export const optionKeys = ["rowspan", "multiline", "headerless", "multibody", "autolabel"] as const;
export type Settings = Required<Options>;
export const initialOptions: Settings = {
  rowspan: true,
  multiline: false,
  headerless: false,
  multibody: true,
  autolabel: true,
};

export const examples = [
  {
    name: "Merged cells & captions",
    source:
      "[Quarterly sales][quarterly-sales]\n| Region | Team   | Sales   ||\n| ^^     | ^^     | Q1 | Q2 |\n| :----- | :----- | --: | --: |\n| North  | Atlas  | 12 | 15 |\n| ^^     | Beacon |  8 | 10 |\n\n| South  | Cedar  |  9 | 11 |\n| Total         || 29 | 36 |",
    options: initialOptions,
  },
  {
    name: "Multiline content",
    source:
      "[Release checklist]\n| Stage   | Tasks          |\\\n| ------- | -------------- |\n| Prepare | - Review API   |\\\n|         | - Run tests    |\n| Ship    | **Publish** the package. |\\\n|         |                |\\\n|         | Then share the release. |",
    options: { ...initialOptions, multiline: true },
  },
  {
    name: "Headerless tables",
    source:
      "| :--------- | --------: |\n| Espresso   | $3.00     |\n| Flat white | $4.50     |\n| Weekend special       ||\n| ^^                    ||",
    options: { ...initialOptions, headerless: true },
  },
  {
    name: "Escapes & Unicode",
    source:
      "[Small details]\n| Content | Example |\n| :------ | :------ |\n| A literal pipe | left\\|right |\n| Code with pipes | `key|value` |\n| Markdown | **bold**, *italic*, [a link](https://github.com/Murlors/multimd-table) |\n| Unicode | 中文 · café · 😀 |",
    options: initialOptions,
  },
];
