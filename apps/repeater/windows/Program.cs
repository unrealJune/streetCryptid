using System.Security.Principal;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Velopack;

namespace StreetCryptid.Repeater;

public static class Program
{
    public static event Action? OpenRequested;
    public static bool Startup { get; private set; }

    [STAThread]
    public static void Main(string[] args)
    {
        VelopackApp.Build()
            // Removing the app must not leave a service running a copy of it, nor strand the
            // identity under ProgramData: bring it home, best effort, within Velopack's budget.
            .OnBeforeUninstallFastCallback(_ =>
            {
                if (Services.ServiceControl.IsInstalled())
                    Services.ServiceControl.UninstallAsync(Core.ServiceLayout.UserStateDirectory,
                        TimeSpan.FromSeconds(25)).GetAwaiter().GetResult();
            })
            .Run();
        Startup = args.Contains("--startup");
        string name = @"Local\streetCryptid.Repeater." + WindowsIdentity.GetCurrent().User!.Value;
        using var activate = new EventWaitHandle(false, EventResetMode.AutoReset, name + ".activate");
        using var mutex = new Mutex(true, name, out bool first);
        if (!first)
        {
            if (!Startup) activate.Set();
            return;
        }
        using var registration = new WaitRegistration(activate, () => OpenRequested?.Invoke());
        WinRT.ComWrappersSupport.InitializeComWrappers();
        Application.Start(initialization =>
        {
            SynchronizationContext.SetSynchronizationContext(
                new DispatcherQueueSynchronizationContext(DispatcherQueue.GetForCurrentThread()));
            _ = new App();
        });
    }

    private sealed class WaitRegistration : IDisposable
    {
        private readonly RegisteredWaitHandle registration;
        public WaitRegistration(WaitHandle handle, Action action) =>
            registration = ThreadPool.RegisterWaitForSingleObject(handle, (_, _) => action(), null, -1, false);
        public void Dispose() => registration.Unregister(null);
    }
}
