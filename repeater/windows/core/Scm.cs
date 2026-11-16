using System.ComponentModel;
using System.Runtime.InteropServices;

namespace StreetCryptid.Repeater.Core;

/// <summary>The few Service Control Manager calls the installer and the app need.</summary>
public static unsafe class Scm
{
    private const uint ScManagerAllAccess = 0xF003F;
    private const uint ScManagerConnect = 0x0001;
    private const uint ServiceAllAccess = 0xF01FF;
    private const uint ServiceQueryStatus = 0x0004;
    private const uint ServiceStart = 0x0010;
    private const uint ServiceDemandStart = 3;
    private const uint DaclSecurityInformation = 4;
    private const uint ErrorServiceSpecificError = 1066;
    private const uint ServiceWin32OwnProcess = 0x10;
    private const uint ServiceAutoStart = 2;
    private const uint ServiceErrorNormal = 1;
    private const uint ServiceNoChange = 0xFFFFFFFF;
    private const int ErrorServiceDoesNotExist = 1060;
    private const int ErrorServiceNotActive = 1062;
    private const int ErrorServiceAlreadyRunning = 1056;
    private const int ErrorServiceMarkedForDelete = 1072;

    public const uint Stopped = 1;
    public const uint Running = 4;

    public static bool IsInstalled(string name = ServiceLayout.ServiceName)
    {
        using var manager = OpenManager(ScManagerConnect);
        using var service = OpenService(manager, ServiceQueryStatus, throwIfMissing: false, name);
        return service is not null;
    }

    /// <summary>The service's process id and state, or null when it is not installed.</summary>
    public static (uint ProcessId, uint State)? Query()
    {
        var status = QueryFull(ServiceLayout.ServiceName);
        return status is { } s ? (s.ProcessId, s.State) : null;
    }

    /// <summary>
    /// A service's state and, once stopped, the code it exited with (its service-specific code when
    /// it reported one). Null when it is not installed. Needs only query access.
    /// </summary>
    public static (uint ProcessId, uint State, uint ExitCode)? QueryFull(string name)
    {
        using var manager = OpenManager(ScManagerConnect);
        using var service = OpenService(manager, ServiceQueryStatus, throwIfMissing: false, name);
        if (service is null) return null;
        var status = QueryStatus(service);
        uint exit = status.Win32ExitCode == ErrorServiceSpecificError
            ? status.ServiceSpecificExitCode : status.Win32ExitCode;
        return (status.ProcessId, status.CurrentState, exit);
    }

    /// <summary>
    /// Start a service with one argument, opening it with nothing but start access — which is all
    /// the owner is granted on the updater. False when it was already running.
    /// </summary>
    public static bool StartWith(string name, string argument)
    {
        using var manager = OpenManager(ScManagerConnect);
        using var service = OpenService(manager, ServiceStart, throwIfMissing: true, name)!;
        fixed (char* value = argument)
        {
            char* arguments = value;
            if (StartServiceW(service.Value, 1, (IntPtr)(&arguments))) return true;
        }
        int error = Marshal.GetLastWin32Error();
        if (error == ErrorServiceAlreadyRunning) return false;
        throw new Win32Exception(error);
    }

    /// <summary>
    /// Create the updater, or point an existing one at <paramref name="commandLine"/> again: a
    /// demand-start LocalSystem service whose DACL lets <paramref name="owner"/> start it and read
    /// its status, and nothing more. SYSTEM and Administrators keep full control.
    /// </summary>
    [System.Runtime.Versioning.SupportedOSPlatform("windows")]
    public static void InstallUpdater(string commandLine, string owner)
    {
        using var manager = OpenManager(ScManagerAllAccess);
        var service = OpenService(manager, ServiceAllAccess, throwIfMissing: false, ServiceLayout.UpdaterName);
        if (service is null)
        {
            service = new Handle(CreateServiceW(manager.Value, ServiceLayout.UpdaterName,
                ServiceLayout.UpdaterDisplayName, ServiceAllAccess, ServiceWin32OwnProcess, ServiceDemandStart,
                ServiceErrorNormal, commandLine, null, IntPtr.Zero, null, null, null));
            if (service.Value == IntPtr.Zero) throw new Win32Exception();
        }
        else if (!ChangeServiceConfigW(service.Value, ServiceWin32OwnProcess, ServiceDemandStart, ServiceErrorNormal,
                     commandLine, null, IntPtr.Zero, null, "LocalSystem", null, ServiceLayout.UpdaterDisplayName))
            throw new Win32Exception();
        using (service)
        {
            fixed (char* description = ServiceLayout.UpdaterDescription)
            {
                var info = new ServiceDescription { Description = description };
                Configure(service, 1, &info);
            }
            // SY and BA: full control. The owner: query status (LC), start (RP), read control (RC).
            var descriptor = new System.Security.AccessControl.RawSecurityDescriptor(
                $"D:P(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;LCRPRC;;;{new System.Security.Principal.SecurityIdentifier(owner).Value})");
            var binary = new byte[descriptor.BinaryLength];
            descriptor.GetBinaryForm(binary, 0);
            fixed (byte* sd = binary)
                if (!SetServiceObjectSecurity(service.Value, DaclSecurityInformation, sd)) throw new Win32Exception();
        }
    }

    /// <summary>
    /// Create the service, or point an existing one at <paramref name="commandLine"/> again. It
    /// runs as its own virtual account, starts after boot settles, restarts if it dies, and holds
    /// only the one privilege it needs — in particular not SeImpersonate, which every service
    /// account is otherwise given and which is the usual road from a service to SYSTEM.
    /// </summary>
    public static void Install(string commandLine)
    {
        using var manager = OpenManager(ScManagerAllAccess);
        var service = OpenService(manager, ServiceAllAccess, throwIfMissing: false);
        if (service is null)
        {
            service = new Handle(CreateServiceW(manager.Value, ServiceLayout.ServiceName,
                ServiceLayout.DisplayName, ServiceAllAccess, ServiceWin32OwnProcess, ServiceAutoStart,
                ServiceErrorNormal, commandLine, null, IntPtr.Zero, null, ServiceLayout.Account, null));
            if (service.Value == IntPtr.Zero) throw new Win32Exception();
        }
        else if (!ChangeServiceConfigW(service.Value, ServiceWin32OwnProcess, ServiceAutoStart, ServiceErrorNormal,
                     commandLine, null, IntPtr.Zero, null, ServiceLayout.Account, null,
                     ServiceLayout.DisplayName))
            throw new Win32Exception();
        using (service)
        {
            fixed (char* description = ServiceLayout.Description)
            {
                var info = new ServiceDescription { Description = description };
                Configure(service, 1, &info);
            }
            var delayed = new ServiceDelayedAutoStartInfo { DelayedAutoStart = 1 };
            Configure(service, 3, &delayed);
            var sid = new ServiceSidInfo { SidType = 1 }; // SERVICE_SID_TYPE_UNRESTRICTED
            Configure(service, 5, &sid);
            fixed (char* privileges = "SeChangeNotifyPrivilege\0\0")
            {
                var required = new ServiceRequiredPrivilegesInfo { Privileges = privileges };
                Configure(service, 6, &required);
            }
            var actions = stackalloc ScAction[3];
            actions[0] = new ScAction { Type = 1, Delay = 10_000 };
            actions[1] = new ScAction { Type = 1, Delay = 60_000 };
            actions[2] = new ScAction { Type = 1, Delay = 300_000 };
            var failure = new ServiceFailureActions { ResetPeriod = 86_400, Count = 3, Actions = actions };
            Configure(service, 2, &failure);
        }
    }

    public static void Start(string name = ServiceLayout.ServiceName)
    {
        using var manager = OpenManager(ScManagerConnect);
        using var service = OpenService(manager, ServiceAllAccess, throwIfMissing: true, name)!;
        if (!StartServiceW(service.Value, 0, IntPtr.Zero) &&
            Marshal.GetLastWin32Error() != ErrorServiceAlreadyRunning)
            throw new Win32Exception();
    }

    /// <summary>Stop the service and wait for it; false if it is still running at the deadline.</summary>
    public static bool Stop(TimeSpan timeout, string name = ServiceLayout.ServiceName)
    {
        using var manager = OpenManager(ScManagerConnect);
        using var service = OpenService(manager, ServiceAllAccess, throwIfMissing: false, name);
        if (service is null) return true;
        var status = new ServiceStatusRaw();
        if (!ControlService(service.Value, 1, &status))
        {
            int error = Marshal.GetLastWin32Error();
            if (error != ErrorServiceNotActive) throw new Win32Exception(error);
        }
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            if (QueryStatus(service).CurrentState == Stopped) return true;
            Thread.Sleep(250);
        }
        return QueryStatus(service).CurrentState == Stopped;
    }

    public static void Delete(string name = ServiceLayout.ServiceName)
    {
        using var manager = OpenManager(ScManagerConnect);
        using var service = OpenService(manager, ServiceAllAccess, throwIfMissing: false, name);
        if (service is null) return;
        if (!DeleteService(service.Value) && Marshal.GetLastWin32Error() != ErrorServiceMarkedForDelete)
            throw new Win32Exception();
    }

    private static Handle OpenManager(uint access)
    {
        var handle = new Handle(OpenSCManagerW(null, null, access));
        if (handle.Value == IntPtr.Zero) throw new Win32Exception();
        return handle;
    }

    private static Handle? OpenService(Handle manager, uint access, bool throwIfMissing,
        string name = ServiceLayout.ServiceName)
    {
        IntPtr service = OpenServiceW(manager.Value, name, access);
        if (service != IntPtr.Zero) return new Handle(service);
        int error = Marshal.GetLastWin32Error();
        if (error == ErrorServiceDoesNotExist && !throwIfMissing) return null;
        throw new Win32Exception(error);
    }

    private static ServiceStatusProcess QueryStatus(Handle service)
    {
        var status = new ServiceStatusProcess();
        if (!QueryServiceStatusEx(service.Value, 0, &status, (uint)sizeof(ServiceStatusProcess), out _))
            throw new Win32Exception();
        return status;
    }

    private static void Configure(Handle service, uint level, void* info)
    {
        if (!ChangeServiceConfig2W(service.Value, level, info)) throw new Win32Exception();
    }

    private sealed class Handle(IntPtr value) : IDisposable
    {
        public IntPtr Value { get; } = value;
        public void Dispose() { if (Value != IntPtr.Zero) CloseServiceHandle(Value); }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ServiceDescription { public char* Description; }

    [StructLayout(LayoutKind.Sequential)]
    private struct ServiceDelayedAutoStartInfo { public int DelayedAutoStart; }

    [StructLayout(LayoutKind.Sequential)]
    private struct ServiceSidInfo { public uint SidType; }

    [StructLayout(LayoutKind.Sequential)]
    private struct ServiceRequiredPrivilegesInfo { public char* Privileges; }

    [StructLayout(LayoutKind.Sequential)]
    private struct ScAction { public uint Type; public uint Delay; }

    [StructLayout(LayoutKind.Sequential)]
    private struct ServiceFailureActions
    {
        public uint ResetPeriod;
        public char* RebootMessage;
        public char* Command;
        public uint Count;
        public ScAction* Actions;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ServiceStatusRaw
    {
        public uint ServiceType, CurrentState, ControlsAccepted, Win32ExitCode,
            ServiceSpecificExitCode, CheckPoint, WaitHint;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ServiceStatusProcess
    {
        public uint ServiceType, CurrentState, ControlsAccepted, Win32ExitCode,
            ServiceSpecificExitCode, CheckPoint, WaitHint, ProcessId, ServiceFlags;
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr OpenSCManagerW(string? machine, string? database, uint access);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr OpenServiceW(IntPtr manager, string name, uint access);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateServiceW(IntPtr manager, string name, string displayName, uint access,
        uint serviceType, uint startType, uint errorControl, string binaryPath, string? loadOrderGroup,
        IntPtr tagId, string? dependencies, string? account, string? password);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ChangeServiceConfigW(IntPtr service, uint serviceType, uint startType,
        uint errorControl, string binaryPath, string? loadOrderGroup, IntPtr tagId, string? dependencies,
        string? account, string? password, string displayName);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ChangeServiceConfig2W(IntPtr service, uint level, void* info);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool StartServiceW(IntPtr service, uint argumentCount, IntPtr arguments);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ControlService(IntPtr service, uint control, ServiceStatusRaw* status);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryServiceStatusEx(IntPtr service, int level, ServiceStatusProcess* buffer,
        uint size, out uint needed);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DeleteService(IntPtr service);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetServiceObjectSecurity(IntPtr service, uint information, byte* descriptor);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseServiceHandle(IntPtr handle);
}
