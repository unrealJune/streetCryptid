using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace StreetCryptid.Repeater.Core;

/// <summary>A job object that kills its processes when the last handle to it closes.</summary>
public sealed class NativeLifetime : IDisposable
{
    private readonly SafeFileHandle handle;

    public NativeLifetime(IntPtr process)
    {
        handle = CreateJobObjectW(IntPtr.Zero, null);
        var limits = new ExtendedLimitInformation();
        limits.Basic.LimitFlags = 0x2000; // KILL_ON_JOB_CLOSE
        if (handle.IsInvalid || !SetInformationJobObject(handle, 9, ref limits,
                (uint)Marshal.SizeOf<ExtendedLimitInformation>()) ||
            !AssignProcessToJobObject(handle, process))
        {
            handle.Dispose();
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        }
    }

    public void Dispose() => handle.Dispose();

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimitInformation
    {
        public long ProcessTime, JobTime;
        public uint LimitFlags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveProcesses;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimitInformation
    {
        public BasicLimitInformation Basic;
        public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemory, PeakJobMemory;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateJobObjectW(IntPtr attributes, string? name);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(SafeFileHandle job, int informationClass,
        ref ExtendedLimitInformation information, uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(SafeFileHandle job, IntPtr process);
}
