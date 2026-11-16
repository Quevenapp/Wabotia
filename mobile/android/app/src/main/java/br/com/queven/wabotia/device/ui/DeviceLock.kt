package br.com.queven.wabotia.device.ui

import android.app.Activity
import android.app.ActivityManager
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.ContextWrapper
import br.com.queven.wabotia.device.WabotiaDeviceAdminReceiver

/** Como a tela do aparelho está presa ao app. */
enum class DeviceLockState {
    /** Nada prende: Início e Recentes saem do app. */
    NONE,

    /** Fixação de tela (instalação comum): Início e Recentes não saem; o gesto do sistema desafixa. */
    PINNED,

    /** Modo quiosque (o app é o administrador do aparelho): só o app desfaz, depois do PIN. */
    LOCKED,
}

/**
 * A trava do modo aparelho com o que o Android oferece sem permissão especial (docs em `mobile/android/MODO-APARELHO.md`):
 * - instalação comum: `startLockTask()` pede a fixação de tela, e o Android pergunta a quem está diante do aparelho se
 *   confirma; com "Fixação de apps" desligada nos ajustes do sistema, pode não fixar;
 * - app como *device owner* (`adb shell dpm set-device-owner …` num aparelho zerado): o pacote entra em
 *   `setLockTaskPackages` e a trava é silenciosa, sem a pergunta e sem o gesto do sistema.
 * Só o app sai da trava (`stopLockTask()`), e só depois do PIN: nos ajustes, ao desfazer o pareamento ou ao sair da
 * demonstração.
 */
object DeviceLock {
    fun state(context: Context): DeviceLockState {
        val manager = context.getSystemService(ActivityManager::class.java) ?: return DeviceLockState.NONE
        return when (runCatching { manager.lockTaskModeState }.getOrDefault(ActivityManager.LOCK_TASK_MODE_NONE)) {
            ActivityManager.LOCK_TASK_MODE_LOCKED -> DeviceLockState.LOCKED
            ActivityManager.LOCK_TASK_MODE_PINNED -> DeviceLockState.PINNED
            else -> DeviceLockState.NONE
        }
    }

    /** O app foi feito administrador do aparelho (*device owner*): a trava não precisa de confirmação. */
    fun isDeviceOwner(context: Context): Boolean =
        runCatching { context.getSystemService(DevicePolicyManager::class.java)?.isDeviceOwnerApp(context.packageName) == true }
            .getOrDefault(false)

    /**
     * Prende a tela no app. Como *device owner*, libera o próprio pacote para a trava (exige o receiver de administrador,
     * [WabotiaDeviceAdminReceiver]) e entra sem perguntar; sem isso, o Android mostra o pedido de fixação. Já presa,
     * não faz nada.
     */
    fun enter(activity: Activity) {
        if (isDeviceOwner(activity)) {
            runCatching {
                val policy = activity.getSystemService(DevicePolicyManager::class.java)
                val admin = ComponentName(activity, WabotiaDeviceAdminReceiver::class.java)
                if (policy != null && !policy.isLockTaskPermitted(activity.packageName)) {
                    policy.setLockTaskPackages(admin, arrayOf(activity.packageName))
                }
            }
        }
        if (state(activity) != DeviceLockState.NONE) return
        // Fora do primeiro plano o Android recusa; a próxima tela do papel pede de novo.
        runCatching { activity.startLockTask() }
    }

    /** Solta a tela (só chamado depois do PIN). */
    fun exit(activity: Activity) {
        if (state(activity) == DeviceLockState.NONE) return
        runCatching { activity.stopLockTask() }
    }
}

/** A Activity por trás de um contexto de Compose. */
internal tailrec fun Context.findActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
}
