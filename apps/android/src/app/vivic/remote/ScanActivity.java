package app.vivic.remote;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.drawable.GradientDrawable;
import android.hardware.Camera;
import android.os.Bundle;
import android.view.Gravity;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.View;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.DecodeHintType;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.Result;
import com.google.zxing.common.HybridBinarizer;
import com.google.zxing.qrcode.QRCodeReader;
import java.util.EnumMap;
import java.util.Map;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Local QR decoding. Frames are never uploaded or persisted; microphone is not requested. */
@SuppressWarnings("deprecation")
public final class ScanActivity extends Activity implements SurfaceHolder.Callback {
  private SurfaceView preview;
  private Camera camera;
  private boolean surfaceReady;
  private volatile boolean finishing;
  private final ExecutorService decoder = Executors.newSingleThreadExecutor();
  private int dp(float value) { return Math.round(value * getResources().getDisplayMetrics().density); }
  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    FrameLayout root = new FrameLayout(this);
    root.setBackgroundColor(Color.BLACK);
    preview = new SurfaceView(this);
    root.addView(preview, new FrameLayout.LayoutParams(-1, -1));
    View guide = new View(this) {
      final Paint stroke = new Paint(Paint.ANTI_ALIAS_FLAG);
      @Override protected void onDraw(Canvas canvas) {
        stroke.setColor(0xfff5f5f7); stroke.setStyle(Paint.Style.STROKE); stroke.setStrokeWidth(dp(2));
        float side = Math.min(getWidth() - dp(64), dp(260));
        float left = (getWidth() - side) / 2, top = Math.max(dp(60), (getHeight() - side - dp(180)) / 2);
        canvas.drawRoundRect(left, top, left + side, top + side, dp(20), dp(20), stroke);
      }
    };
    root.addView(guide, new FrameLayout.LayoutParams(-1, -1));
    LinearLayout controls = new LinearLayout(this);
    controls.setOrientation(LinearLayout.VERTICAL);
    controls.setPadding(dp(20), dp(20), dp(20), dp(20));
    controls.setBackgroundColor(0xf21d1d1f);
    TextView title = new TextView(this);
    title.setText("扫描电脑 Vivic 二维码"); title.setTextSize(20); title.setTextColor(0xfff5f5f7);
    controls.addView(title);
    TextView hint = new TextView(this);
    hint.setText("将二维码放入框内。识别后会返回确认连接。"); hint.setTextSize(14); hint.setTextColor(0xffc7c7cd); hint.setPadding(0, dp(10), 0, dp(16));
    controls.addView(hint);
    Button cancel = new Button(this); cancel.setText("取消扫码，输入配对码"); cancel.setTextSize(14); cancel.setMinHeight(dp(48)); cancel.setTextColor(0xff1d1d1f); cancel.setAllCaps(false);
    GradientDrawable buttonSurface = new GradientDrawable(); buttonSurface.setColor(0xfff5f5f7); buttonSurface.setCornerRadius(dp(24)); cancel.setBackground(buttonSurface);
    cancel.setOnClickListener(view -> fail("已取消扫码，可返回输入配对码。")); controls.addView(cancel);
    FrameLayout.LayoutParams position = new FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM);
    root.addView(controls, position); setContentView(root);
    preview.getHolder().addCallback(this);
    if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) requestPermissions(new String[]{Manifest.permission.CAMERA}, 72);
  }
  @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
    super.onRequestPermissionsResult(request, permissions, results);
    if (request == 72 && results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) openCamera();
    else fail("相机权限未开启。可输入配对码；需要扫码时再到系统设置允许相机。");
  }
  @Override public void surfaceCreated(SurfaceHolder holder) { surfaceReady = true; openCamera(); }
  @Override public void surfaceChanged(SurfaceHolder holder, int format, int width, int height) { }
  @Override public void surfaceDestroyed(SurfaceHolder holder) { surfaceReady = false; closeCamera(); }
  private void openCamera() {
    if (finishing || camera != null || !surfaceReady || checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) return;
    try {
      int id = 0;
      Camera.CameraInfo info = new Camera.CameraInfo();
      for (int i = 0; i < Camera.getNumberOfCameras(); i++) { Camera.getCameraInfo(i, info); if (info.facing == Camera.CameraInfo.CAMERA_FACING_BACK) { id = i; break; } }
      Camera.getCameraInfo(id, info);
      camera = Camera.open(id);
      Camera.Parameters params = camera.getParameters();
      Camera.Size selected = null;
      for (Camera.Size size : params.getSupportedPreviewSizes()) if (size.width <= 1280 && size.width >= 640 && (selected == null || size.width > selected.width)) selected = size;
      if (selected == null) selected = params.getPreviewSize();
      params.setPreviewSize(selected.width, selected.height);
      List<String> focusModes = params.getSupportedFocusModes();
      if (focusModes != null && focusModes.contains(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE)) params.setFocusMode(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE);
      camera.setParameters(params);
      int rotation = getWindowManager().getDefaultDisplay().getRotation() * 90;
      int orientation = info.facing == Camera.CameraInfo.CAMERA_FACING_FRONT ? (360 - (info.orientation + rotation) % 360) % 360 : (info.orientation - rotation + 360) % 360;
      camera.setDisplayOrientation(orientation);
      View viewport = (View) preview.getParent();
      int imageWidth = orientation % 180 == 0 ? selected.width : selected.height;
      int imageHeight = orientation % 180 == 0 ? selected.height : selected.width;
      float scale = Math.max((float) viewport.getWidth() / imageWidth, (float) viewport.getHeight() / imageHeight);
      if (scale > 0) preview.setLayoutParams(new FrameLayout.LayoutParams(Math.round(imageWidth * scale), Math.round(imageHeight * scale), Gravity.CENTER));
      camera.setPreviewDisplay(preview.getHolder()); camera.startPreview(); nextFrame();
    } catch (Exception ignored) { fail("相机暂不可用。请返回输入配对码，或稍后重新扫码。"); }
  }
  private void nextFrame() {
    if (camera == null || finishing) return;
    camera.setOneShotPreviewCallback((bytes, source) -> {
      if (finishing || camera == null) return;
      Camera.Size size = source.getParameters().getPreviewSize();
      decoder.execute(() -> {
        String value = null;
        try {
          PlanarYUVLuminanceSource image = new PlanarYUVLuminanceSource(bytes, size.width, size.height, 0, 0, size.width, size.height, false);
          QRCodeReader reader = new QRCodeReader();
          Map<DecodeHintType,Object> hints = new EnumMap<>(DecodeHintType.class); hints.put(DecodeHintType.TRY_HARDER, Boolean.TRUE);
          Result result;
          try { result = reader.decode(new BinaryBitmap(new HybridBinarizer(image)), hints); }
          catch (Exception absent) { result = reader.decode(new BinaryBitmap(new HybridBinarizer(image.invert())), hints); }
          value = result.getText();
        } catch (Exception absent) { /* A frame without a QR code is normal. */ }
        final String decoded = value;
        runOnUiThread(() -> {
          if (finishing) return;
          if (decoded != null && decoded.length() <= 1024) {
            finishing = true; closeCamera(); setResult(RESULT_OK, new Intent().putExtra("value", decoded)); finish();
          } else preview.postDelayed(this::nextFrame, 180);
        });
      });
    });
  }
  private void closeCamera() { if (camera != null) { Camera closing = camera; camera = null; try { closing.setPreviewCallback(null); closing.stopPreview(); } catch (RuntimeException ignored) { } finally { closing.release(); } } }
  private void fail(String message) { if (finishing) return; finishing = true; closeCamera(); setResult(RESULT_CANCELED, new Intent().putExtra("error", message)); finish(); }
  @Override public void onBackPressed() { fail("已取消扫码，可返回输入配对码。"); }
  @Override protected void onPause() { closeCamera(); super.onPause(); }
  @Override protected void onResume() { super.onResume(); openCamera(); }
  @Override protected void onDestroy() { finishing = true; closeCamera(); decoder.shutdownNow(); super.onDestroy(); }
}
