# Runs a command with a terminal of its own, or with none at all — the two
# situations install.sh's Bun question has to tell apart, since `curl | sh`
# leaves the script's own stdin on the pipe and the question goes to /dev/tty.
# Bun.spawn can arrange neither, so the tests borrow Python's pty for it.
#
#   terminal.py tty "y\n" -- cmd...   command gets its own controlling
#                                     terminal, with that typed at it
#   terminal.py none -- cmd...        command gets no controlling terminal
#
# In tty mode the command's stdout and stderr both come back on the terminal,
# so they arrive here interleaved, as a person at the keyboard would see them.
# Like a real terminal it answers "where is the cursor?" (ESC [ 6 n), which
# .NET asks around every Read-Host; left unanswered, each query waits out a
# timeout of its own and a PowerShell prompt takes seconds.
import os
import subprocess
import sys

mode = sys.argv[1]
command = sys.argv[sys.argv.index("--") + 1 :]

if mode == "none":
    # A new session has no controlling terminal, so opening /dev/tty fails.
    sys.exit(subprocess.call(command, start_new_session=True))

import pty

answer = sys.argv[2]
# pty.fork() gives the child the terminal as its controlling one (setsid plus
# TIOCSCTTY), which plain redirection would not.
pid, fd = pty.fork()
if pid == 0:
    os.execvp(command[0], command)

# The line discipline holds the answer until the script reads it, so it can be
# typed before the prompt is printed.
os.write(fd, answer.encode())
CURSOR_QUERY = b"\x1b[6n"
out = bytearray()
answered = 0
while True:
    try:
        chunk = os.read(fd, 65536)
    except OSError:
        break  # Linux raises EIO where macOS reports end of file
    if not chunk:
        break
    out += chunk
    # Counted over everything read so far, so a query split across two reads
    # is still answered once.
    asked = out.count(CURSOR_QUERY)
    try:
        while answered < asked:
            os.write(fd, b"\x1b[1;1R")
            answered += 1
    except OSError:
        pass  # the command has gone, and asks nothing more
sys.stdout.buffer.write(out)
sys.stdout.buffer.flush()
sys.exit(os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1]))
