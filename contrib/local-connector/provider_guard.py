"""Own the adapter tree before launching it; reclaim it if the connector dies.

This helper inherits the connector pipes without reading/writing their protocol.
The Windows job handle is private and non-inheritable. All adapter descendants
therefore die when the guardian exits, including if it is forcibly terminated.
"""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import threading
import time


def windows_guard(parent_pid: int):
    import ctypes
    from ctypes import wintypes

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel.CreateJobObjectW.restype = wintypes.HANDLE
    kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    kernel.SetInformationJobObject.restype = wintypes.BOOL
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel.AssignProcessToJobObject.restype = wintypes.BOOL
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel.WaitForSingleObject.restype = wintypes.DWORD
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.restype = wintypes.BOOL

    class BasicLimits(ctypes.Structure):
        _fields_ = [("PerProcessUserTimeLimit", ctypes.c_longlong), ("PerJobUserTimeLimit", ctypes.c_longlong),
                    ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                    ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                    ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD),
                    ("SchedulingClass", wintypes.DWORD)]

    class IoCounters(ctypes.Structure):
        _fields_ = [(name, ctypes.c_ulonglong) for name in ("ReadOperationCount", "WriteOperationCount",
                    "OtherOperationCount", "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

    class ExtendedLimits(ctypes.Structure):
        _fields_ = [("BasicLimitInformation", BasicLimits), ("IoInfo", IoCounters),
                    ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                    ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]

    parent = kernel.OpenProcess(0x00100000, False, parent_pid)  # SYNCHRONIZE; preserves process identity
    if not parent:
        raise ctypes.WinError(ctypes.get_last_error())
    job = kernel.CreateJobObjectW(None, None)
    if not job:
        kernel.CloseHandle(parent)
        raise ctypes.WinError(ctypes.get_last_error())
    limits = ExtendedLimits()
    limits.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if not kernel.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
        kernel.CloseHandle(parent)
        kernel.CloseHandle(job)
        raise ctypes.WinError(ctypes.get_last_error())
    if not kernel.AssignProcessToJobObject(job, kernel.GetCurrentProcess()):
        kernel.CloseHandle(parent)
        kernel.CloseHandle(job)
        raise ctypes.WinError(ctypes.get_last_error())

    def watch() -> None:
        # Any wait failure is fail-closed too: no unowned adapter should survive.
        kernel.WaitForSingleObject(parent, 0xFFFFFFFF)
        kernel.CloseHandle(job)  # Also kills this guardian and its descendants.
        os._exit(1)

    threading.Thread(target=watch, daemon=True).start()
    return lambda: kernel.CloseHandle(job)


def unix_guard(parent_pid: int):
    # Connector starts this guardian as the leader of its own session/group.
    # Adapter descendants inherit that group; never signal a name or a port.
    def cleanup() -> None:
        os.killpg(os.getpgrp(), signal.SIGKILL)

    def watch() -> None:
        while os.getppid() == parent_pid:
            time.sleep(0.05)
        cleanup()

    threading.Thread(target=watch, daemon=True).start()
    return cleanup


def main() -> int:
    parent_pid = int(sys.argv[1])
    cleanup = windows_guard(parent_pid) if os.name == "nt" else unix_guard(parent_pid)
    try:
        # No provider is spawned unless ownership and the parent watch exist.
        process = subprocess.Popen(sys.argv[2:], stdin=sys.stdin, stdout=sys.stdout, stderr=sys.stderr)
        return process.wait()
    finally:
        cleanup()


if __name__ == "__main__":
    raise SystemExit(main())
