using System.Runtime.InteropServices;
using StreetCryptid.Repeater.Core;

namespace StreetCryptid.Repeater.Service;

/// <summary>
/// The Service Control Manager's side of the process, by hand: <c>ServiceBase</c> is not
/// native-AOT friendly, and this is all of it — report starting, run, honour stop and shutdown,
/// report stopped with an exit code the SCM's recovery actions can act on.
/// </summary>
internal static unsafe class ServiceDispatcher
{
    private const uint ServiceWin32OwnProcess = 0x10;
    private const uint StartPending = 2, StopPending = 3, Running = 4, Stopped = 1;
    private const uint AcceptStop = 0x1, AcceptShutdown = 0x4;
    private const uint ControlStop = 1, ControlInterrogate = 4, ControlShutdown = 5;

    private static Func<CancellationToken, Task>? body;
    private static readonly CancellationTokenSource Stopping = new();
    private static IntPtr statusHandle;
    private static uint checkpoint;

    /// <summary>Blocks until the service has stopped. False when not started by the SCM.</summary>
    public static bool Run(Func<CancellationToken, Task> run)
    {
        body = run;
        fixed (char* name = ServiceLayout.ServiceName)
        {
            var table = stackalloc ServiceTableEntry[2];
            table[0] = new ServiceTableEntry { Name = name, Proc = &ServiceMain };
            table[1] = default;
            return StartServiceCtrlDispatcherW(table);
        }
    }

    [UnmanagedCallersOnly]
    private static void ServiceMain(uint argc, char** argv)
    {
        statusHandle = RegisterServiceCtrlHandlerExW(ServiceLayout.ServiceName, &Handler, IntPtr.Zero);
        if (statusHandle == IntPtr.Zero) return;
        Report(StartPending, 0, 30_000);
        uint exitCode = 0;
        try
        {
            var task = body!(Stopping.Token);
            Report(Running, 0, 0);
            task.GetAwaiter().GetResult();
        }
        catch (OperationCanceledException) when (Stopping.IsCancellationRequested) { }
        catch
        {
            // A non-zero exit lets the SCM's failure actions restart the service.
            exitCode = 1;
        }
        Report(Stopped, exitCode, 0);
    }

    [UnmanagedCallersOnly]
    private static uint Handler(uint control, uint eventType, IntPtr eventData, IntPtr context)
    {
        switch (control)
        {
            case ControlStop:
            case ControlShutdown:
                Report(StopPending, 0, 30_000);
                Stopping.Cancel();
                return 0;
            case ControlInterrogate:
                return 0;
            default:
                return 120; // ERROR_CALL_NOT_IMPLEMENTED
        }
    }

    private static void Report(uint state, uint exitCode, uint waitHint)
    {
        var status = new ServiceStatus
        {
            ServiceType = ServiceWin32OwnProcess,
            CurrentState = state,
            ControlsAccepted = state == Running ? AcceptStop | AcceptShutdown : 0,
            Win32ExitCode = exitCode == 0 ? 0 : 1066u, // ERROR_SERVICE_SPECIFIC_ERROR
            ServiceSpecificExitCode = exitCode,
            CheckPoint = state is StartPending or StopPending ? ++checkpoint : 0,
            WaitHint = waitHint,
        };
        SetServiceStatus(statusHandle, &status);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ServiceTableEntry
    {
        public char* Name;
        public delegate* unmanaged<uint, char**, void> Proc;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ServiceStatus
    {
        public uint ServiceType, CurrentState, ControlsAccepted, Win32ExitCode,
            ServiceSpecificExitCode, CheckPoint, WaitHint;
    }

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool StartServiceCtrlDispatcherW(ServiceTableEntry* table);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr RegisterServiceCtrlHandlerExW(string name,
        delegate* unmanaged<uint, uint, IntPtr, IntPtr, uint> handler, IntPtr context);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetServiceStatus(IntPtr handle, ServiceStatus* status);
}
