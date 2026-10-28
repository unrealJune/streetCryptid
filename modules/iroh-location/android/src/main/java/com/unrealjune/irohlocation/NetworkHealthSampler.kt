package com.unrealjune.irohlocation

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import android.util.Log
import java.net.Inet6Address
import uniffi.iroh_location.NetworkContext
import uniffi.iroh_location.recordNetworkHealth

/**
 * `net.health` from the Android process — see `net_health.rs` for why it exists.
 *
 * Rust counts relay failures and reads the endpoint; this adds the half only the OS knows: which
 * network the process is on, whether Android validated it or saw a captive portal, whether a VPN
 * carries it, and what private DNS is doing. A relay failure that follows a network rather than a
 * relay is the question this answers. Every read is a cached `ConnectivityManager` lookup, cheap
 * enough for the five-minute pulse.
 */
internal object NetworkHealthSampler {
  private const val TAG = "IrohNetHealth"

  @Volatile private var context: Context? = null

  fun init(context: Context) {
    this.context = context.applicationContext
  }

  fun sample(trigger: String) {
    if (!IrohAndroidBootstrap.installed) return
    try {
      recordNetworkHealth(trigger, readContext())
    } catch (e: Throwable) {
      Log.w(TAG, "net.health not recorded", e)
    }
  }

  private fun readContext(): NetworkContext? {
    val cm =
      context?.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return null
    val network = cm.activeNetwork ?: return NetworkContext(transport = "none")
    val caps = cm.getNetworkCapabilities(network)
    val link = cm.getLinkProperties(network)
    val transports =
      listOf(
          NetworkCapabilities.TRANSPORT_WIFI to "wifi",
          NetworkCapabilities.TRANSPORT_CELLULAR to "cellular",
          NetworkCapabilities.TRANSPORT_ETHERNET to "ethernet",
          NetworkCapabilities.TRANSPORT_BLUETOOTH to "bluetooth",
          NetworkCapabilities.TRANSPORT_VPN to "vpn",
        )
        .filter { (transport, _) -> caps?.hasTransport(transport) == true }
        .joinToString("+") { it.second }
    val privateDns =
      if (link != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        when {
          !link.isPrivateDnsActive -> "off"
          link.privateDnsServerName != null -> "strict:${link.privateDnsServerName}"
          else -> "opportunistic"
        }
      } else {
        null
      }
    val hasIpv6 =
      link?.linkAddresses?.any { la ->
        val addr = la.address
        addr is Inet6Address &&
          !addr.isLinkLocalAddress &&
          !addr.isLoopbackAddress &&
          !addr.isSiteLocalAddress &&
          // fc00::/7 (unique local) is not a route to the internet either.
          (addr.address[0].toInt() and 0xfe) != 0xfc
      }
    return NetworkContext(
      transport = transports.ifEmpty { "other" },
      validated = caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED),
      captivePortal = caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_CAPTIVE_PORTAL),
      vpn = caps?.hasTransport(NetworkCapabilities.TRANSPORT_VPN),
      privateDns = privateDns,
      hasIpv6 = hasIpv6,
    )
  }
}
