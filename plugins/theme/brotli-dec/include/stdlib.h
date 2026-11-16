#ifndef KTB_STDLIB_H
#define KTB_STDLIB_H
#include <stddef.h>
void *malloc(size_t);
void free(void *);
void *calloc(size_t, size_t);
void *realloc(void *, size_t);
void exit(int);
void abort(void);
#endif
