import assert from "node:assert/strict";
import test from "node:test";
import { closestSortedIndex, nextAssistantIndices } from "./message-navigation";

test("next assistant is strictly after each row, including consecutive user rows", () => {
  assert.deepEqual(
    nextAssistantIndices(["user", "user", "assistant", "assistant", "user"]),
    [2, 2, 3, undefined, undefined],
  );
  assert.deepEqual(nextAssistantIndices([]), []);
});

test("closestSortedIndex reads only logarithmically many row centers", () => {
  let reads = 0;
  const index = closestSortedIndex(1024, 317.7, (row) => {
    reads += 1;
    return row * 1.5;
  });
  assert.equal(index, 212);
  assert.ok(reads <= 14, `unexpected layout read count: ${reads}`);
});

test("closestSortedIndex handles edges, gaps and an empty transcript", () => {
  const centers = [10, 100, 500];
  const lookup = (index: number) => centers[index]!;
  assert.equal(closestSortedIndex(0, 5, lookup), -1);
  assert.equal(closestSortedIndex(3, -50, lookup), 0);
  assert.equal(closestSortedIndex(3, 90, lookup), 1);
  assert.equal(closestSortedIndex(3, 301, lookup), 2);
  assert.equal(closestSortedIndex(3, 999, lookup), 2);
});
