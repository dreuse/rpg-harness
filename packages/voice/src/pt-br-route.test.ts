import assert from 'node:assert/strict';
import { test } from 'node:test';
import { choosePtBrRoute, PT_BR_ROUTE_ENV } from './pt-br-route.ts';

test('Apple Silicon takes the mlx fast path', () => {
  assert.equal(choosePtBrRoute('darwin', 'arm64', {}), 'mlx');
});

test('Intel Macs, Windows and Linux take the ONNX route', () => {
  assert.equal(choosePtBrRoute('darwin', 'x64', {}), 'onnx');
  assert.equal(choosePtBrRoute('win32', 'x64', {}), 'onnx');
  assert.equal(choosePtBrRoute('linux', 'arm64', {}), 'onnx');
});

test('the switch disables mlx on Apple Silicon', () => {
  assert.equal(choosePtBrRoute('darwin', 'arm64', { [PT_BR_ROUTE_ENV]: 'onnx' }), 'onnx');
  assert.equal(choosePtBrRoute('darwin', 'arm64', { [PT_BR_ROUTE_ENV]: 'mlx' }), 'mlx');
});

test('the switch never forces mlx where it cannot run', () => {
  assert.equal(choosePtBrRoute('win32', 'x64', { [PT_BR_ROUTE_ENV]: 'mlx' }), 'onnx');
});
