process.stdout.write([
  "\x1b[?25l",
  "\x1b[H\x1b[48;2;40;50;40m\x1b[2K ROW ONE",
  "\x1b[2;1H\x1b[2K ROW TWO",
  "\x1b[0m\x1b[3;1H\x1b[2K",
  "\x1b[4;1H\x1b[48;2;40;50;40m\x1b[2K ROW THREE\x1b[0m",
].join(""));
setInterval(() => {}, 60_000);
