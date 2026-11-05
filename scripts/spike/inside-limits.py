"""Runs inside the sandbox: checks that the memory and process limits really hold.

The test caps (6 GB, 4000 processes) keep this safe even if a limit does not hold.
"""
import os
import signal
import sys
import time

BLOCK = 100 * 1024 * 1024
MEMORY_BLOCKS = 60
PROCESS_CAP = 4000


def memory():
    blocks = []
    for index in range(MEMORY_BLOCKS):
        block = bytearray(BLOCK)
        for offset in range(0, BLOCK, 4096):
            block[offset] = 1
        blocks.append(block)
        print(f"allocated {(index + 1) * 100} MB", flush=True)
    print("bomb-complete", flush=True)


def fork():
    children = []
    message = ""
    try:
        for _ in range(PROCESS_CAP):
            pid = os.fork()
            if pid == 0:
                time.sleep(30)
                os._exit(0)
            children.append(pid)
        message = "fork-complete"
    except OSError as error:
        message = f"fork-stopped errno={error.errno}"
    print(f"{message} count={len(children)}", flush=True)
    for pid in children:
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass


if __name__ == "__main__":
    {"memory": memory, "fork": fork}[sys.argv[1]]()
