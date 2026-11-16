package br.com.queven.wabotia.device

import android.app.admin.DeviceAdminReceiver

/**
 * O componente de administrador do aparelho, exigido pelo Android para o modo quiosque: `dpm set-device-owner` aponta
 * para ele, e `DevicePolicyManager.setLockTaskPackages` pede o `ComponentName` do administrador. Não pede nenhuma
 * política (`res/xml/device_admin.xml` vazio) e o app nunca pede para ser ativado: numa instalação comum ele fica
 * inerte. Ver `mobile/android/MODO-APARELHO.md`.
 */
class WabotiaDeviceAdminReceiver : DeviceAdminReceiver()
