package multimd

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

func TestMergedTable(t *testing.T) {
	table, err := Parse("A|B\n-|-\nmerged||\n^^||", DefaultOptions|2)
	if err != nil {
		t.Fatal(err)
	}
	cell := table.Sections[1].Rows[0].Cells[0]
	if cell.Colspan != 2 || cell.Rowspan != 2 || cell.Value.String() != "merged" {
		t.Fatalf("unexpected cell: %+v", cell)
	}
}

func TestIsolatedSurrogate(t *testing.T) {
	table, err := ParseUTF16([]uint16{'A', '|', 'B', '\n', '-', '|', '-', '\n', 0xd800, '|', 'x'}, DefaultOptions)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(table.Sections[1].Rows[0].Cells[0].Value, Text{0xd800}) {
		t.Fatal("surrogate changed")
	}
}

func TestSharedVectors(t *testing.T) {
	path := os.Getenv("MULTIMD_VECTORS")
	if path == "" {
		t.Skip("set MULTIMD_VECTORS to the generated vector file")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		ID      string          `json:"id"`
		Source  Text            `json:"source"`
		Options map[string]bool `json:"options"`
		Model   *Table          `json:"model"`
	}
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		flags := DefaultOptions
		for i, key := range []string{"multiline", "rowspan", "headerless", "multibody", "autolabel"} {
			if v, ok := c.Options[key]; ok {
				if v {
					flags |= 1 << i
				} else {
					flags &^= 1 << i
				}
			}
		}
		actual, err := ParseUTF16(c.Source, flags)
		if err != nil {
			t.Fatalf("%s: %v", c.ID, err)
		}
		if !reflect.DeepEqual(actual, c.Model) {
			t.Fatalf("%s: complete model mismatch", c.ID)
		}
	}
}
