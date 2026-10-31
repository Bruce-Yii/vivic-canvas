package app.vivic.remote;

import android.app.Activity;
import android.content.Intent;
import android.content.res.Configuration;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import org.json.JSONObject;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.IOException;
import java.security.MessageDigest;
import android.util.Base64;
import java.util.HashMap;
import java.util.Map;

/** Bundled controller UI, scoped scanner and user-chosen read-only original export. */
public final class MainActivity extends Activity {
  private static final String HOST = "appassets.androidplatform.net";
  private static final String ENTRY = "https://" + HOST + "/assets/index.html";
  private WebView web;
  private boolean scanning;
  private volatile String pendingSaveId;
  private byte[] pendingSaveBytes;
  private boolean choosingFile;
  private boolean trusted(Uri uri) { return "https".equals(uri.getScheme()) && HOST.equals(uri.getHost()) && uri.getPort() == -1 && uri.getUserInfo() == null && uri.getPath() != null && uri.getPath().startsWith("/assets/"); }
  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    web = new WebView(this);
    web.setBackgroundColor(0xffc0d2e0);
    setContentView(web);
    WebSettings settings = web.getSettings();
    settings.setJavaScriptEnabled(true);
    settings.setDomStorageEnabled(false);
    settings.setAllowFileAccess(false);
    settings.setAllowContentAccess(false);
    settings.setAllowFileAccessFromFileURLs(false);
    settings.setAllowUniversalAccessFromFileURLs(false);
    settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
    settings.setMediaPlaybackRequiresUserGesture(true);
    settings.setJavaScriptCanOpenWindowsAutomatically(false);
    settings.setSupportMultipleWindows(false);
    settings.setSafeBrowsingEnabled(true);
    settings.setTextZoom(Math.round(getResources().getConfiguration().fontScale * 100));
    WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG_WEBVIEW);
    web.addJavascriptInterface(new ScannerBridge(), "VivicAndroid");
    web.setWebChromeClient(new WebChromeClient() {
      @Override public void onPermissionRequest(PermissionRequest request) { request.deny(); }
    });
    web.setWebViewClient(new WebViewClient() {
      @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        // No QR, external link, iframe, redirect or new page can reach this bridge.
        return true;
      }
      @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        Uri uri = request.getUrl();
        // Only the scoped phone transport can leave the immutable UI origin.
        // The bundled UI asks the user to confirm the scanned HTTPS host first.
        if ("https".equals(uri.getScheme()) && uri.getUserInfo() == null && uri.getQuery() == null
            && uri.getPort() != 80 && "POST".equals(request.getMethod()) && uri.getPath() != null
            && uri.getPath().matches("/api/online/mobile/phone/(connect|poll|send|disconnect)")) return null;
        if ("https".equals(uri.getScheme()) && uri.getUserInfo() == null && uri.getQuery() == null
            && "OPTIONS".equals(request.getMethod()) && uri.getPath() != null
            && uri.getPath().matches("/api/online/mobile/phone/(connect|poll|send|disconnect)")) return null;
        if (!trusted(uri) || !"GET".equals(request.getMethod()) || uri.getQuery() != null) return denied();
        String path = uri.getPath().substring("/assets/".length());
        if (path.contains("..") || path.contains("\\") || path.isEmpty()) return denied();
        try {
          InputStream content = getAssets().open("web/" + path);
          String mime = path.endsWith(".html") ? "text/html" : (path.endsWith(".js") || path.endsWith(".mjs")) ? "text/javascript" : path.endsWith(".css") ? "text/css" : path.endsWith(".woff2") ? "font/woff2" : path.endsWith(".svg") ? "image/svg+xml" : path.endsWith(".webp") ? "image/webp" : path.endsWith(".png") ? "image/png" : "application/octet-stream";
          Map<String, String> headers = new HashMap<>();
          headers.put("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:; connect-src wss: https:; media-src blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'");
          headers.put("X-Content-Type-Options", "nosniff");
          headers.put("Cache-Control", "no-store");
          return new WebResourceResponse(mime, "UTF-8", 200, "OK", headers, content);
        } catch (Exception ignored) { return denied(); }
      }
    });
    web.loadUrl(ENTRY);
  }
  private WebResourceResponse denied() { return new WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", new HashMap<>(), new ByteArrayInputStream(new byte[0])); }
  private final class ScannerBridge {
    @JavascriptInterface public void scan() {
      runOnUiThread(() -> {
        if (scanning || web.getUrl() == null || !trusted(Uri.parse(web.getUrl()))) return;
        scanning = true;
        startActivityForResult(new Intent(MainActivity.this, ScanActivity.class), 71);
      });
    }
    @JavascriptInterface public void saveFile(String id, String name, String mime, String encoded, String checksum) {
      if (id == null || !id.matches("[a-zA-Z0-9_-]{1,100}") || name == null || name.length() < 1 || name.length() > 240 || name.matches("(?s).*[\\p{Cntrl}/\\\\].*")
          || encoded == null || encoded.length() > 13333336 || checksum == null || !checksum.matches("[a-f0-9]{64}")) return;
      byte[] bytes;
      try {
        bytes = Base64.decode(encoded, Base64.DEFAULT);
        if (bytes.length > 10000000) return;
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(bytes);
        StringBuilder hex = new StringBuilder(); for (byte value : digest) hex.append(String.format("%02x", value & 255));
        if (!hex.toString().equals(checksum)) return;
      } catch (Exception ignored) { return; }
      final byte[] original = bytes;
      runOnUiThread(() -> {
        if (web.getUrl() == null || !trusted(Uri.parse(web.getUrl()))) return;
        if (pendingSaveId != null) { saveResult(id, false, "已有一个文件正在保存"); return; }
        pendingSaveId = id; pendingSaveBytes = original; choosingFile = true;
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("application/octet-stream").putExtra(Intent.EXTRA_TITLE, name);
        try { startActivityForResult(intent, 72); }
        catch (Exception ignored) { pendingSaveId = null; pendingSaveBytes = null; choosingFile = false; saveResult(id, false, "无法打开系统保存位置"); }
      });
    }
    @JavascriptInterface public void cancelSave(String id) {
      runOnUiThread(() -> {
        if (web.getUrl() == null || !trusted(Uri.parse(web.getUrl())) || id == null || !id.equals(pendingSaveId)) return;
        pendingSaveId = null; pendingSaveBytes = null;
        if (choosingFile) { choosingFile = false; finishActivity(72); }
      });
    }
  }
  private void saveResult(String id, boolean ok, String error) {
    if (web == null || web.getUrl() == null || !trusted(Uri.parse(web.getUrl()))) return;
    JSONObject detail = new JSONObject();
    try { detail.put("id", id); detail.put("ok", ok); if (error != null) detail.put("error", error); }
    catch (Exception ignored) { return; }
    web.evaluateJavascript("window.dispatchEvent(new CustomEvent('vivic:file-save-result',{detail:" + detail + "}))", null);
  }
  @Override protected void onActivityResult(int request, int result, Intent data) {
    super.onActivityResult(request, result, data);
    if (request == 72) {
      choosingFile = false;
      final String id = pendingSaveId; final byte[] bytes = pendingSaveBytes; pendingSaveBytes = null;
      if (id == null || bytes == null) return;
      if (result != RESULT_OK || data == null || data.getData() == null) { pendingSaveId = null; saveResult(id, false, "已取消保存"); return; }
      final Uri target = data.getData();
      new Thread(() -> {
        boolean ok = false;
        try {
          if (!id.equals(pendingSaveId)) return;
          if (!"content".equals(target.getScheme())) throw new IOException("invalid save target");
          try (OutputStream output = getContentResolver().openOutputStream(target, "w")) {
            if (output == null) throw new IOException("save target unavailable");
            if (!id.equals(pendingSaveId)) return;
            output.write(bytes); output.flush(); ok = true;
          }
        } catch (Exception ignored) { }
        final boolean success = ok;
        runOnUiThread(() -> { if (!id.equals(pendingSaveId)) return; pendingSaveId = null; saveResult(id, success, success ? null : "保存失败，请选择其他位置"); });
      }, "vivic-file-save").start();
      return;
    }
    if (request != 71) return;
    scanning = false;
    if (web.getUrl() == null || !trusted(Uri.parse(web.getUrl()))) return;
    JSONObject detail = new JSONObject();
    try {
      if (result == RESULT_OK && data != null) detail.put("value", data.getStringExtra("value"));
      else detail.put("error", data != null ? data.getStringExtra("error") : "已取消扫码，可返回输入配对码。");
    } catch (Exception ignored) { return; }
    web.evaluateJavascript("window.dispatchEvent(new CustomEvent('vivic:scan-result',{detail:" + detail + "}))", null);
  }
  @Override public void onBackPressed() {
    web.evaluateJavascript("(() => { const e = new Event('vivic:native-back',{cancelable:true}); window.dispatchEvent(e); return e.defaultPrevented; })()", handled -> {
      if (!"true".equals(handled)) moveTaskToBack(true);
    });
  }
  @Override public void onConfigurationChanged(Configuration config) { super.onConfigurationChanged(config); web.getSettings().setTextZoom(Math.round(config.fontScale * 100)); }
  @Override protected void onDestroy() { pendingSaveId = null; pendingSaveBytes = null; if (web != null) { web.removeJavascriptInterface("VivicAndroid"); web.destroy(); } super.onDestroy(); }
}
