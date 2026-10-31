import com.google.zxing.BinaryBitmap;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.common.BitMatrix;
import com.google.zxing.common.HybridBinarizer;
import com.google.zxing.qrcode.QRCodeReader;
import com.google.zxing.qrcode.QRCodeWriter;
import com.google.zxing.BarcodeFormat;

/** The exact scanner decode pipeline, fed synthetic YUV luminance; no physical camera. */
public final class QrDecoderSmoke {
  public static void main(String[] args) throws Exception {
    String payload = "https://edsionc.top/vivic-remote/#pair=0123456789ABCDEF";
    int size = 640;
    BitMatrix qr = new QRCodeWriter().encode(payload, BarcodeFormat.QR_CODE, size, size);
    for (int rotation = 0; rotation < 4; rotation++) {
      for (boolean invert : new boolean[]{false, true}) {
        byte[] bytes = new byte[size * size];
        for (int y = 0; y < size; y++) for (int x = 0; x < size; x++) bytes[y * size + x] = (byte)((qr.get(x, y) ^ invert) ? 0 : 255);
        PlanarYUVLuminanceSource source = new PlanarYUVLuminanceSource(bytes, size, size, 0, 0, size, size, false);
        QRCodeReader reader = new QRCodeReader();
        String decoded;
        try { decoded = reader.decode(new BinaryBitmap(new HybridBinarizer(source))).getText(); }
        catch (Exception notFound) { decoded = reader.decode(new BinaryBitmap(new HybridBinarizer(source.invert()))).getText(); }
        if (!payload.equals(decoded)) throw new AssertionError("QR round trip failed");
      }
      qr.rotate90();
    }
    System.out.println("QR decoder: 4 rotations x normal/inverted passed (synthetic frames)");
  }
}
