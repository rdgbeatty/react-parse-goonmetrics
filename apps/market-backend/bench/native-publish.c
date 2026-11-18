#define _POSIX_C_SOURCE 200809L
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <unistd.h>

/* Benchmark-only LE float64 table format, written by the measured Node JSON adapter.
 * No JSON parser, raw order history, network code, or production dependency is hidden here. */
typedef struct { uint32_t rows, width; double *data; } Table;
typedef struct { uint32_t id, length; double volume; unsigned char *name; } Item;
static void fail(const char *message) { fprintf(stderr, "%s\n", message); exit(1); }
static void path(char *out, const char *directory, const char *name) {
  if (snprintf(out, 4096, "%s/%s", directory, name) >= 4096) fail("Path too long");
}
static void read_exact(void *out, size_t size, size_t count, FILE *file) { if (fread(out, size, count, file) != count) fail("Truncated binary state"); }
static Table read_table(const char *directory, const char *name, uint32_t expected_width) {
  char filename[4096]; path(filename, directory, name); FILE *file = fopen(filename, "rb"); if (!file) fail("Cannot open numeric state");
  Table table; read_exact(&table.rows, 4, 1, file); read_exact(&table.width, 4, 1, file);
  if (table.width != expected_width || table.rows > 10000000) fail("Invalid numeric table dimensions");
  size_t cells = (size_t)table.rows * table.width; table.data = malloc(cells * sizeof(double)); if (!table.data && cells) fail("Out of memory");
  read_exact(table.data, sizeof(double), cells, file); if (fgetc(file) != EOF) fail("Trailing numeric state"); fclose(file); return table;
}
static FILE *begin_write(const char *directory, const char *name, char *temp, char *target) {
  char basename[256]; if (snprintf(basename, sizeof(basename), "%s.tmp", name) >= (int)sizeof(basename)) fail("Name too long");
  path(temp, directory, basename); path(target, directory, name); FILE *file = fopen(temp, "wb"); if (!file) fail("Cannot write state");
  setvbuf(file, NULL, _IOFBF, 1048576); return file;
}
static void commit(FILE *file, const char *temp, const char *target) {
  if (fflush(file) || fsync(fileno(file)) || fclose(file) || rename(temp, target)) fail("Durable publication failed");
}
static Item *read_items(const char *directory, uint32_t expected) {
  char filename[4096]; path(filename, directory, "items"); FILE *file = fopen(filename, "rb"); if (!file) fail("Cannot open item state");
  uint32_t count; read_exact(&count, 4, 1, file); if (count != expected) fail("Item count mismatch");
  Item *items = calloc(count, sizeof(Item)); if (!items) fail("Out of memory");
  for (uint32_t i = 0; i < count; i++) {
    read_exact(&items[i].id, 4, 1, file); read_exact(&items[i].volume, 8, 1, file); read_exact(&items[i].length, 4, 1, file);
    if (items[i].length > 1048576) fail("Oversized item name");
    items[i].name = malloc(items[i].length + 1); if (!items[i].name) fail("Out of memory"); read_exact(items[i].name, 1, items[i].length, file);
  }
  if (fgetc(file) != EOF) fail("Trailing item data"); fclose(file); return items;
}
static void number(FILE *file, double value) { if (isnan(value)) fputs("null", file); else fprintf(file, "%.17g", value); }
static void string(FILE *file, const unsigned char *bytes, uint32_t length) {
  fputc('"', file);
  for (uint32_t i = 0; i < length; i++) {
    unsigned char ch = bytes[i];
    if (ch == '"' || ch == '\\') { fputc('\\', file); fputc(ch, file); }
    else if (ch < 32) fprintf(file, "\\u%04x", ch);
    else fputc(ch, file);
  }
  fputc('"', file);
}
static void print_table(FILE *file, const Table *table) {
  fputc('[', file);
  for (uint32_t row = 0; row < table->rows; row++) {
    if (row) fputc(',', file); fputc('[', file);
    for (uint32_t col = 0; col < table->width; col++) { if (col) fputc(',', file); number(file, table->data[(size_t)row * table->width + col]); }
    fputc(']', file);
  }
  fputc(']', file);
}
int main(int argc, char **argv) {
  uint16_t endian = 1; if (*(unsigned char *)&endian != 1 || sizeof(double) != 8) fail("Benchmark binary format requires LE float64");
  if (argc != 5) fail("Usage: native-publish state-dir summarize|publish type-count as-of-day");
  const char *directory = argv[1]; uint32_t types = (uint32_t)strtoul(argv[3], NULL, 10); if (!types || types > 1000000) fail("Invalid type count");
  int as_of_day = atoi(argv[4]);
  Table summary;
  if (!strcmp(argv[2], "summarize")) {
    Table history = read_table(directory, "history", 8); summary.rows = types * 3; summary.width = 4;
    summary.data = calloc((size_t)summary.rows * 4, sizeof(double)); uint8_t *counts = calloc((size_t)summary.rows * 2, 1);
    if (!summary.data || !counts) fail("Out of memory");
    for (uint32_t i = 0; i < summary.rows; i++) { summary.data[(size_t)i * 4] = i / types; summary.data[(size_t)i * 4 + 1] = i % types; }
    for (uint32_t i = 0; i < history.rows; i++) {
      const double *row = history.data + (size_t)i * 8;
      if (row[0] < 0 || row[0] >= 3 || row[1] < 0 || row[1] >= types || row[2] > as_of_day || row[2] < as_of_day - 20) fail("Invalid history index");
      size_t index = (size_t)row[0] * types + (size_t)row[1];
      if (as_of_day - row[2] < 7) { summary.data[index * 4 + 2] += row[3]; counts[index * 2]++; }
      if (as_of_day - row[2] < 14) { summary.data[index * 4 + 3] += row[3]; counts[index * 2 + 1]++; }
    }
    for (uint32_t i = 0; i < summary.rows; i++) {
      if (counts[(size_t)i * 2] != 7) summary.data[(size_t)i * 4 + 2] = NAN;
      if (counts[(size_t)i * 2 + 1] != 14) summary.data[(size_t)i * 4 + 3] = NAN;
    }
    char temp[4096], target[4096]; FILE *state = begin_write(directory, "summaries", temp, target);
    if (fwrite(&summary.rows, 4, 1, state) != 1 || fwrite(&summary.width, 4, 1, state) != 1 ||
      fwrite(summary.data, 8, (size_t)summary.rows * 4, state) != (size_t)summary.rows * 4) fail("Summary write failed");
    commit(state, temp, target); free(history.data); free(counts);
  } else if (!strcmp(argv[2], "publish")) summary = read_table(directory, "summaries", 4);
  else fail("Unknown operation");
  Item *items = read_items(directory, types); Table quotes = read_table(directory, "quotes", 11);
  char temp[4096], target[4096]; FILE *output = begin_write(directory, "public.json", temp, target);
  fputs("{\"schemaVersion\":2,\"items\":[", output);
  for (uint32_t i = 0; i < types; i++) {
    if (i) fputc(',', output); fprintf(output, "[%u,", items[i].id); string(output, items[i].name, items[i].length); fputc(',', output); number(output, items[i].volume); fputc(']', output);
    free(items[i].name);
  }
  fputs("],\"quotes\":", output); print_table(output, &quotes); fputs(",\"summaries\":", output); print_table(output, &summary); fputc('}', output);
  commit(output, temp, target); free(items); free(quotes.data); free(summary.data); return 0;
}
