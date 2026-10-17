import assert from "node:assert/strict";
import test from "node:test";
import { parseRsaKeyResponse } from "../src/lotto/auth.js";
import { isTransient } from "../src/lotto/purchase-policy.js";

test("parses nested and top-level RSA key responses", () => {
  assert.deepEqual(
    parseRsaKeyResponse('{"data":{"rsaModulus":"abcd","publicExponent":"010001"}}'),
    { modulus: "abcd", exponent: "010001" }
  );
  assert.deepEqual(
    parseRsaKeyResponse('{"rsaModulus":"1234","publicExponent":"03"}'),
    { modulus: "1234", exponent: "03" }
  );
});

test("treats the HTTP 200 maintenance page as a transient outage", () => {
  assert.throws(
    () => parseRsaKeyResponse("<!DOCTYPE html><title>시스템 점검 페이지</title><p>시스템 정기 점검</p>"),
    (error) => error instanceof Error && isTransient(error) && error.message.includes("status=503")
  );
});

test("reports unexpected HTML without leaking the response body", () => {
  assert.throws(
    () => parseRsaKeyResponse("<!DOCTYPE html><title>Unexpected page</title>"),
    /returned HTML instead of JSON/
  );
});
