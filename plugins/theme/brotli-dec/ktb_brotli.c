/*
 * ktb_brotli.c — zero-import Brotli decompress wrapper for wasm32.
 *
 * Build (from a google/brotli v1.1.0 checkout):
 *   B=/path/to/brotli/c
 *   for f in $B/dec/{bit_reader,decode,huffman,state}.c \
 *            $B/common/{constants,context,dictionary,transform,platform,shared_dictionary}.c \
 *            ktb_brotli.c; do
 *     clang --target=wasm32-unknown-unknown -O2 -ffreestanding -fno-builtin \
 *       -fno-stack-protector -nostdlib -Iinclude -I$B/include -I$B/common \
 *       -c $f -o $(basename $f .c).o
 *   done
 *   wasm-ld -o brotli-dec.wasm bit_reader.o decode.o huffman.o state.o \
 *     constants.o context.o dictionary.o transform.o platform.o \
 *     shared_dictionary.o ktb_brotli.o --no-entry \
 *     --export=ktb_reserve --export=ktb_brotli_decompress \
 *     --export=ktb_result_ptr --export-memory
 *
 * The four stub headers in include/ replace libc headers that have no
 * wasm32-freestanding equivalents (string/stdlib/stdio/memory).
 */
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <brotli/decode.h>

typedef uint8_t u8;
typedef uint32_t u32;
typedef uint64_t u64;
typedef uintptr_t uptr;

static u8* heap_cur;
static u8* heap_base;
static u32 res_ptr;
static u32 res_len;

static void* ktb_alloc(void* opaque, size_t size) {
	(void)opaque;
	if (size == 0) size = 1;
	size = (size + 15u) & ~(size_t)15u;
	if (!heap_base) {
		heap_base = (u8*)(uptr)(__builtin_wasm_memory_size(0) << 16);
	}
	if (!heap_cur) heap_cur = heap_base;
	uptr need = (uptr)heap_cur + size;
	u32 have = __builtin_wasm_memory_size(0) << 16;
	if (need > have) {
		u32 pages = (u32)((need - have + 65535u) >> 16);
		if (__builtin_wasm_memory_grow(0, pages) == (u32)-1) return 0;
	}
	void* p = heap_cur;
	heap_cur += size;
	return p;
}

static void ktb_free(void* opaque, void* address) {
	(void)opaque; (void)address;
}

/* libc symbols referenced by brotli sources; routed into the same arena. */
void* malloc(size_t size) { return ktb_alloc(0, size); }
void free(void* p) { (void)p; }
void* calloc(size_t n, size_t size) {
	void* p = ktb_alloc(0, n * size);
	if (p) memset(p, 0, n * size);
	return p;
}

/* Ensures at least n bytes are writable starting at the heap base and
 * returns that base offset. Callers write input there, then invoke
 * ktb_brotli_decompress. */
uint32_t ktb_reserve(uint32_t n) {
	if (!heap_base) {
		heap_base = (u8*)(uptr)(__builtin_wasm_memory_size(0) << 16);
	}
	uptr need = (uptr)heap_base + ((uptr)n + 65535u) & ~(uptr)65535u;
	u32 have = __builtin_wasm_memory_size(0) << 16;
	if (need > have) {
		u32 pages = (u32)((need - have + 65535u) >> 16);
		if (__builtin_wasm_memory_grow(0, pages) == (u32)-1) return 0;
	}
	return (u32)(uptr)heap_base;
}

/* in_ptr/in_len: compressed brotli stream already in linear memory.
 * out_cap: upper bound for the output buffer (caller passes the expected
 * decompressed size + slack). Returns decompressed length, or -1 on error.
 * Result bytes are readable at ktb_result_ptr() in exported memory. */
int32_t ktb_brotli_decompress(uint32_t in_ptr, uint32_t in_len,
		uint32_t out_cap) {
	res_ptr = 0; res_len = 0;
	u8* in_copy = (u8*)ktb_alloc(0, in_len);
	if (!in_copy) return -1;
	memcpy(in_copy, (const void*)(uptr)in_ptr, in_len);

	BrotliDecoderState* s = BrotliDecoderCreateInstance(ktb_alloc, ktb_free, 0);
	if (!s) return -1;
	u8* out = (u8*)ktb_alloc(0, (size_t)out_cap + 65536u);
	if (!out) { BrotliDecoderDestroyInstance(s); return -1; }

	const uint8_t* next_in = in_copy;
	size_t avail_in = in_len;
	uint8_t* next_out = out;
	size_t avail_out = (size_t)out_cap + 65536u;
	BrotliDecoderResult r = BrotliDecoderDecompressStream(
		s, &avail_in, &next_in, &avail_out, &next_out, 0);
	int32_t ret = -1;
	if (r == BROTLI_DECODER_RESULT_SUCCESS) {
		ret = (int32_t)((size_t)out_cap + 65536u - avail_out);
		res_ptr = (u32)(uptr)out;
		res_len = (u32)ret;
	}
	BrotliDecoderDestroyInstance(s);
	heap_cur = heap_base;
	return ret;
}

uint32_t ktb_result_ptr(void) { return res_ptr; }

/* libc string/memory routines (compiled with -fno-builtin). */
void* memcpy(void* dst, const void* src, size_t n) {
	u8* d = (u8*)dst; const u8* s = (const u8*)src;
	while (n >= 8) { u64 v; __builtin_memcpy(&v, s, 8); __builtin_memcpy(d, &v, 8); d += 8; s += 8; n -= 8; }
	while (n--) *d++ = *s++;
	return dst;
}
void* memmove(void* dst, const void* src, size_t n) {
	u8* d = (u8*)dst; const u8* s = (const u8*)src;
	if (d < s) { while (n--) *d++ = *s++; }
	else { d += n; s += n; while (n--) *--d = *--s; }
	return dst;
}
void* memset(void* dst, int c, size_t n) {
	u8* d = (u8*)dst; u8 v = (u8)c;
	while (n >= 8) { u64 x = v * 0x0101010101010101ULL; __builtin_memcpy(d, &x, 8); d += 8; n -= 8; }
	while (n--) *d++ = v;
	return dst;
}
int memcmp(const void* a, const void* b, size_t n) {
	const u8* x = (const u8*)a; const u8* y = (const u8*)b;
	while (n--) { if (*x != *y) return *x - *y; x++; y++; }
	return 0;
}
size_t strlen(const char* s) { size_t n = 0; while (s[n]) n++; return n; }
