# Zapis zasobow procesu Python na koniec kroku: szczyt RSS i czas CPU. Windows przez psapi, Linux przez resource.
import json, sys, time


def peak_rss_mb():
    if sys.platform == 'win32':
        import ctypes
        from ctypes import wintypes

        class PMC(ctypes.Structure):
            _fields_ = [('cb', wintypes.DWORD), ('PageFaultCount', wintypes.DWORD), ('PeakWorkingSetSize', ctypes.c_size_t),
                        ('WorkingSetSize', ctypes.c_size_t), ('QuotaPeakPagedPoolUsage', ctypes.c_size_t), ('QuotaPagedPoolUsage', ctypes.c_size_t),
                        ('QuotaPeakNonPagedPoolUsage', ctypes.c_size_t), ('QuotaNonPagedPoolUsage', ctypes.c_size_t),
                        ('PagefileUsage', ctypes.c_size_t), ('PeakPagefileUsage', ctypes.c_size_t)]
        pmc = PMC()
        pmc.cb = ctypes.sizeof(PMC)
        kernel = ctypes.WinDLL('kernel32')
        kernel.GetCurrentProcess.restype = wintypes.HANDLE
        psapi = ctypes.WinDLL('psapi')
        psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(PMC), wintypes.DWORD]
        psapi.GetProcessMemoryInfo(kernel.GetCurrentProcess(), ctypes.byref(pmc), pmc.cb)
        return round(pmc.PeakWorkingSetSize / 1048576)
    import resource
    return round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024)


def write_res(path, **extra):
    data = {'peakRssMB': peak_rss_mb(), 'cpuS': round(time.process_time(), 1)}
    data.update(extra)
    with open(path, 'w', encoding='utf8') as f:
        json.dump(data, f)
