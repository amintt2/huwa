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
