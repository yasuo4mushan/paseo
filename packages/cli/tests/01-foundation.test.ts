#!/usr/bin/env npx zx

/**
 * Phase 1: Foundation Tests
 *
 * Tests basic CLI functionality that doesn't require a daemon:
 * - aaswitch --version outputs version
 * - aaswitch --help shows commands
 */

import { $ } from "zx";

$.verbose = false;

console.log("📋 Phase 1: Foundation Tests\n");

// Test 1.1: --version outputs version
console.log("  Testing aaswitch --version...");
const versionResult = await $`aaswitch --version`.nothrow();
if (versionResult.exitCode !== 0) {
  console.error("  ❌ aaswitch --version failed with exit code", versionResult.exitCode);
  console.error("     stderr:", versionResult.stderr);
  process.exit(1);
}
const versionOutput = versionResult.stdout.trim();
if (!versionOutput.match(/\d+\.\d+\.\d+/)) {
  console.error("  ❌ aaswitch --version output does not contain version number");
  console.error("     output:", versionOutput);
  process.exit(1);
}
console.log("  ✅ aaswitch --version outputs:", versionOutput);

// Test 1.2: --help shows commands
console.log("  Testing aaswitch --help...");
const helpResult = await $`aaswitch --help`.nothrow();
if (helpResult.exitCode !== 0) {
  console.error("  ❌ aaswitch --help failed with exit code", helpResult.exitCode);
  console.error("     stderr:", helpResult.stderr);
  process.exit(1);
}
const helpOutput = helpResult.stdout;

// Check for expected sections in help output
const expectedTerms = ["agent", "daemon", "Usage", "Options", "Commands"];
const missingTerms = expectedTerms.filter((term) => !helpOutput.includes(term));
if (missingTerms.length > 0) {
  console.error("  ❌ aaswitch --help missing expected terms:", missingTerms.join(", "));
  console.error("     output:", helpOutput);
  process.exit(1);
}
console.log("  ✅ aaswitch --help shows commands");

console.log("\n✅ Phase 1: Foundation Tests PASSED");
