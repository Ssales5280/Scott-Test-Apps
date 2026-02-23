#!/usr/bin/env node

console.log('Welcome to Sample App!');
console.log('This is a simple Node.js application.\n');

// Simple counter
let count = 0;

function increment() {
  count++;
  console.log(`Count: ${count}`);
}

// Run some examples
increment();
increment();
increment();

console.log('\nSample app executed successfully!');
