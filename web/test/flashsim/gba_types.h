/* Native stand-in for libgba's gba_types.h (flashcart simulator build). */
#ifndef GBA_TYPES_SIM_H
#define GBA_TYPES_SIM_H
#include <stdbool.h>
#include <stdint.h>
typedef uint8_t u8;
typedef uint16_t u16;
typedef uint32_t u32;
typedef int32_t s32;
typedef volatile uint8_t vu8;
typedef volatile uint16_t vu16;
typedef volatile uint32_t vu32;
#endif
