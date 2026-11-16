pluginManagement {
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "Wabotia"

// O cupom do totem sai pelo ThermalPrinterKit (biblioteca privada), por caminho local, como no
// Senhapp: `thermalPrinterKitDir` (gradle.properties ou -P), THERMAL_PRINTER_KIT_DIR, ou o primeiro
// `ThermalPrinterKit` que existir subindo da pasta do app (D:\Code\ThermalPrinterKit na bancada).
val thermalPrinterKitDir: File =
    (providers.gradleProperty("thermalPrinterKitDir").orNull
        ?: System.getenv("THERMAL_PRINTER_KIT_DIR"))
        ?.let { file(it) }
        ?: generateSequence(settingsDir.canonicalFile) { it.parentFile }
            .map { File(it, "ThermalPrinterKit") }
            .firstOrNull { File(it, "android").isDirectory }
        ?: error("ThermalPrinterKit não encontrado: defina thermalPrinterKitDir (-PthermalPrinterKitDir=…) ou THERMAL_PRINTER_KIT_DIR.")

includeBuild(File(thermalPrinterKitDir, "android")) {
    dependencySubstitution {
        substitute(module("br.com.thermalprinterkit:thermalprinterkit")).using(project(":"))
        substitute(module("br.com.thermalprinterkit:printher")).using(project(":printher"))
    }
}

include(":app")
