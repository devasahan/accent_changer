use std::path::PathBuf;

fn main() {
    // The app needs Windows' Common Controls v6, which an application manifest
    // asks for. tauri-build links that manifest into the app binary only, so
    // the test binaries of `cargo test` start without it and Windows stops
    // them with STATUS_ENTRYPOINT_NOT_FOUND (0xc0000139). So the linker embeds
    // the same manifest (a copy of tauri-build's default) into every binary
    // instead, the app's and the tests', as Tauri's own crate does for its
    // tests (tauri's build.rs, embed_manifest_for_tests).
    let windows_msvc = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");
    let mut attributes = tauri_build::Attributes::new();
    if windows_msvc {
        attributes = attributes.windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
    }
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
    if windows_msvc {
        let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set by cargo"))
            .join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    }
}
