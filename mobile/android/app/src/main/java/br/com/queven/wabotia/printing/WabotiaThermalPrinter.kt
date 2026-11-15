package br.com.queven.wabotia.printing

import android.content.Context
import android.os.Build
import br.com.thermalprinterkit.AndroidBleThermalPort
import br.com.thermalprinterkit.AndroidBluetoothThermalPort
import br.com.thermalprinterkit.AndroidKeystorePrinterSelectionStore
import br.com.thermalprinterkit.AndroidLocalWifiNetworkProvider
import br.com.thermalprinterkit.AndroidPrinterProfileStore
import br.com.thermalprinterkit.AndroidUsbHostThermalPort
import br.com.thermalprinterkit.BluetoothLeScanAvailability
import br.com.thermalprinterkit.BluetoothLeScanPolicy
import br.com.thermalprinterkit.ThermalPrinter
import br.com.thermalprinterkit.createLocalWifiThermalPrinter

/**
 * A impressora térmica deste aparelho (porta de `createVinkiThermalPrinter` do Senhapp): a composição de produção do
 * `ThermalPrinterKit`, com os quatro transportes (Wi-Fi local, USB, Bluetooth clássico e LE) e os dois armazéns Android.
 *
 * A impressora é do aparelho, não do servidor: quem imprime é o totem que está com ela. O app cria uma só instância
 * ([br.com.queven.wabotia.core.AppContainer.thermalPrinter]) e readota a escolhida uma vez, quando alguém precisa dela,
 * porque readotar uma Bluetooth LE custa uma varredura.
 */
fun createWabotiaThermalPrinter(context: Context): ThermalPrinter {
    val appContext = context.applicationContext
    return createLocalWifiThermalPrinter(
        localWifiNetworkProvider = AndroidLocalWifiNetworkProvider(appContext),
        usbThermalPort = AndroidUsbHostThermalPort(appContext),
        bluetoothThermalPort = AndroidBluetoothThermalPort(appContext),
        bleThermalPort = AndroidBleThermalPort(appContext),
        selectionStore = AndroidKeystorePrinterSelectionStore(appContext),
        profileStore = AndroidPrinterProfileStore(appContext),
        bluetoothLeScanPolicy = wabotiaBluetoothLeScanPolicy(Build.VERSION.SDK_INT),
    )
}

/**
 * Abaixo do Android 12 a varredura BLE exige localização para esse fim, que o app não pede: ali a pessoa usa USB, Wi-Fi
 * ou uma Bluetooth já pareada, e a busca BLE some.
 */
internal fun wabotiaBluetoothLeScanPolicy(sdkInt: Int): BluetoothLeScanPolicy =
    BluetoothLeScanPolicy {
        if (sdkInt >= Build.VERSION_CODES.S) BluetoothLeScanAvailability.AVAILABLE
        else BluetoothLeScanAvailability.UNAVAILABLE_BY_HOST_POLICY
    }
