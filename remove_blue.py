
import sys
import subprocess

def install(package):
    subprocess.check_call([sys.executable, "-m", "pip", "install", package])

try:
    import cv2
    import numpy as np
except ImportError:
    install("opencv-python")
    install("numpy")
    import cv2
    import numpy as np

def remove_blue(img_path, out_path):
    img = cv2.imread(img_path)
    if img is None:
        print("Error: Image not found at", img_path)
        sys.exit(1)
    
    # Convert to BGRA
    img_bgra = cv2.cvtColor(img, cv2.COLOR_BGR2BGRA)
    
    # Convert to HSV to find the blue background
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    
    # Define range for blue in HSV
    # H ranges from 90 to 140 for blue
    lower_blue = np.array([90, 20, 20])
    upper_blue = np.array([150, 255, 255])
    
    mask = cv2.inRange(hsv, lower_blue, upper_blue)
    
    # Soften the mask for better edges
    mask = cv2.GaussianBlur(mask, (3, 3), 0)
    
    # The mask is 255 where blue is found. We want alpha to be 0 there.
    # Alpha = 255 - mask
    alpha = 255 - mask
    
    img_bgra[:, :, 3] = alpha
    
    # Also, we might want to despill the blue from edges, but simple transparency might be enough.
    
    cv2.imwrite(out_path, img_bgra)
    print(f"Saved transparent image to {out_path}")

remove_blue(r"D:\Gemini_Generated_Image_qmbrwsqmbrwsqmbr.png", r"D:\Gemini_Generated_Image_qmbrwsqmbrwsqmbr.png")

