// Package multimd 验证 Go 通过 C ABI 调用同一 Rust 核心；尚不是可发布的 Go 包。
package multimd

/*
#cgo CFLAGS: -I${SRCDIR}/../../include
#cgo LDFLAGS: -L${SRCDIR}/../../target/release -lmultimd_table_core
#cgo darwin linux LDFLAGS: -Wl,-rpath,${SRCDIR}/../../target/release
#include "multimd_table.h"
*/
import "C"

import (
	"encoding/json"
	"fmt"
	"strconv"
	"unicode/utf16"
	"unicode/utf8"
	"unsafe"
)

// Text 保存 UTF-16 单元，包含孤立代理字符；不能用普通 JSON string 解码替代。
type Text []uint16

// String 便于显示；不合法的代理单元按 Go utf16.Decode 规则替换，原值仍保存在 Text。
func (t Text) String() string { return string(utf16.Decode(t)) }

func (t *Text) UnmarshalJSON(data []byte) error {
	if len(data) < 2 || data[0] != '"' || data[len(data)-1] != '"' {
		return fmt.Errorf("expected JSON string")
	}
	var units []uint16
	for i := 1; i < len(data)-1; {
		if data[i] == '\\' {
			if i+1 >= len(data)-1 {
				return fmt.Errorf("truncated escape")
			}
			if data[i+1] == 'u' {
				if i+6 > len(data)-1 {
					return fmt.Errorf("truncated unicode escape")
				}
				n, err := strconv.ParseUint(string(data[i+2:i+6]), 16, 16)
				if err != nil {
					return err
				}
				units = append(units, uint16(n))
				i += 6
				continue
			}
			escapes := map[byte]uint16{'"': '"', '\\': '\\', '/': '/', 'b': '\b', 'f': '\f', 'n': '\n', 'r': '\r', 't': '\t'}
			c, ok := escapes[data[i+1]]
			if !ok {
				return fmt.Errorf("invalid escape")
			}
			units = append(units, c)
			i += 2
			continue
		}
		r, size := utf8.DecodeRune(data[i : len(data)-1])
		if r == utf8.RuneError && size == 1 {
			return fmt.Errorf("invalid UTF-8 response")
		}
		if r <= 0xffff {
			units = append(units, uint16(r))
		} else {
			a, b := utf16.EncodeRune(r)
			units = append(units, uint16(a), uint16(b))
		}
		i += size
	}
	*t = units
	return nil
}

type Range struct {
	Start uint32 `json:"start"`
	End   uint32 `json:"end"`
}
type Column struct {
	Align *string `json:"align"`
	Wrap  bool    `json:"wrap"`
}
type Cell struct {
	Column   uint32  `json:"column"`
	Colspan  uint32  `json:"colspan"`
	Rowspan  uint32  `json:"rowspan"`
	Align    *string `json:"align"`
	Wrap     bool    `json:"wrap"`
	Block    bool    `json:"block"`
	Value    Text    `json:"value"`
	Range    Range   `json:"range"`
	Segments []Range `json:"segments"`
}
type Row struct {
	Cells []Cell `json:"cells"`
	Range Range  `json:"range"`
}
type Section struct {
	Kind  string `json:"kind"`
	Rows  []Row  `json:"rows"`
	Range Range  `json:"range"`
}
type Caption struct {
	Value        Text   `json:"value"`
	ID           *Text  `json:"id"`
	Side         string `json:"side"`
	Range        Range  `json:"range"`
	ContentRange Range  `json:"contentRange"`
}
type Table struct {
	Type     string    `json:"type"`
	Columns  []Column  `json:"columns"`
	Caption  *Caption  `json:"caption"`
	Sections []Section `json:"sections"`
	Range    Range     `json:"range"`
}

const DefaultOptions uint32 = 24

// Parse 读取普通 Go UTF-8 文本；源文坐标始终是 UTF-16 单元，非字节下标。
func Parse(source string, flags uint32) (*Table, error) {
	return ParseUTF16(utf16.Encode([]rune(source)), flags)
}

// ParseUTF16 允许无损传入孤立代理字符，调用期间 Rust 不保留 Go 指针。
func ParseUTF16(source []uint16, flags uint32) (*Table, error) {
	var empty uint16
	pointer := &empty
	if len(source) > 0 {
		pointer = &source[0]
	}
	result := C.mm_parse_json((*C.uint16_t)(unsafe.Pointer(pointer)), C.size_t(len(source)), C.uint32_t(flags))
	defer C.mm_result_free(result)
	length := C.mm_result_len(result)
	if uint64(length) > uint64(^uint(0)>>1) {
		return nil, fmt.Errorf("response exceeds address space")
	}
	bytes := unsafe.Slice((*byte)(unsafe.Pointer(C.mm_result_ptr(result))), int(length))
	var table *Table
	if err := json.Unmarshal(bytes, &table); err != nil {
		return nil, err
	}
	return table, nil
}
