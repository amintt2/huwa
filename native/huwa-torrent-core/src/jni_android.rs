//! JNI exports for `expo.modules.huwatorrent.HuwaTorrentNative` (Kotlin `external fun`s).
//! Thin wrappers over the same helpers as the C ABI; the JSON contract is identical.

use jni::{
    objects::{JClass, JString},
    sys::jstring,
    JNIEnv,
};

use crate::{api, ffi};

fn jstr(env: &mut JNIEnv, s: &JString) -> String {
    env.get_string(s).map(String::from).unwrap_or_default()
}

fn out(env: &JNIEnv, s: String) -> jstring {
    match env.new_string(s) {
        Ok(j) => j.into_raw(),
        Err(_) => std::ptr::null_mut(),
    }
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_huwatorrent_HuwaTorrentNative_nativeVersion<'local>(
    env: JNIEnv<'local>,
    _class: JClass<'local>,
) -> jstring {
    out(&env, crate::VERSION.to_string())
}

/// Hands the app `Context` to rustls-platform-verifier, which checks HTTPS certificates through
/// Android's verifier (its Kotlin part, org.rustls:rustls-platform-verifier, is in the APK).
/// Without it the first HTTPS handshake (https tracker announce, torrent added by https URL)
/// panics in that request's task. Called once before `nativeInit`; later calls are no-ops.
/// Written against jni 0.22 (the verifier's), whose wrappers are `repr(transparent)` over the
/// same raw `JNIEnv*` / `jobject`. A failure is thrown to Kotlin as a RuntimeException.
#[no_mangle]
pub extern "system" fn Java_expo_modules_huwatorrent_HuwaTorrentNative_nativeInitTls<'local>(
    mut env: jni22::EnvUnowned<'local>,
    _class: jni22::objects::JClass<'local>,
    context: jni22::objects::JObject<'local>,
) {
    env.with_env(|env| rustls_platform_verifier::android::init_with_env(env, context))
        .resolve::<jni22::errors::ThrowRuntimeExAndDefault>()
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_huwatorrent_HuwaTorrentNative_nativeInit<'local>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    config_json: JString<'local>,
) -> jstring {
    let cfg = jstr(&mut env, &config_json);
    let res = std::panic::catch_unwind(|| ffi::init_from_json(&cfg))
        .unwrap_or_else(|_| Err(anyhow::anyhow!("panic in init")));
    out(&env, api::envelope(res))
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_huwatorrent_HuwaTorrentNative_nativeCall<'local>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    method: JString<'local>,
    args_json: JString<'local>,
) -> jstring {
    let method = jstr(&mut env, &method);
    let args = jstr(&mut env, &args_json);
    let res = std::panic::catch_unwind(|| ffi::call_json(&method, &args))
        .unwrap_or_else(|_| Err(anyhow::anyhow!("panic in call")));
    out(&env, api::envelope(res))
}

#[no_mangle]
pub extern "system" fn Java_expo_modules_huwatorrent_HuwaTorrentNative_nativeShutdown<'local>(
    _env: JNIEnv<'local>,
    _class: JClass<'local>,
) {
    ffi::shutdown_engine();
}
