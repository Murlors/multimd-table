#ifndef MULTIMD_TABLE_CORE_H
#define MULTIMD_TABLE_CORE_H
#include <stddef.h>
#include <stdint.h>

/* 内部 C ABI，尚无稳定性承诺。输入借用且只在调用期间读取。
 * 输入以 UTF-16 单元计长；返回 UTF-8 JSON，孤立代理字符保持为 \uXXXX。
 * 返回指针/长度在 mm_result_free 前有效，调用方不能自行 free 内部数据。
 */
typedef struct MmBuffer MmBuffer;
MmBuffer *mm_parse_json(const uint16_t *source, size_t length, uint32_t flags);
const uint8_t *mm_result_ptr(const MmBuffer *buffer);
size_t mm_result_len(const MmBuffer *buffer);
void mm_result_free(MmBuffer *buffer);
#endif
