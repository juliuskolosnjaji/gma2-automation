'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');
const readline = require('readline');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const host = config.gma2.telnetHost || '127.0.0.1';
const port = config.gma2.telnetPort || 30000;

const socket = net.createConnection({ host, port });
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'gMA2> ' });

socket.setEncoding('utf8');

socket.on('connect', () => {
  console.log(`Connected to ${host}:${port}`);
  console.log('Type raw gMA2 commands. Examples:');
  console.log(`  Login "${config.gma2.telnetUser || 'Administrator'}" "${config.gma2.telnetPassword || ''}"`);
  console.log('  LoadShow "Showfile_Hamlet" /nosave /noconfirm');
  console.log('  Macro "VK Einrichtung (Hamlet)"');
  console.log('Type .exit to quit.');
  rl.prompt();
});

socket.on('data', data => {
  process.stdout.write('\n' + data + '\n');
  rl.prompt();
});

socket.on('error', err => {
  console.error(`Telnet error: ${err.message}`);
  process.exitCode = 1;
});

socket.on('close', () => {
  console.log('\nConnection closed');
  process.exit();
});

rl.on('line', line => {
  const cmd = line.trim();
  if (cmd === '.exit' || cmd === 'exit' || cmd === 'quit') {
    socket.destroy();
    rl.close();
    return;
  }
  if (cmd) socket.write(cmd + '\r\n');
  rl.prompt();
});
