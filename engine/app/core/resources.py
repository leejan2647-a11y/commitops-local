from .analysis_storage import connect
from .config import get_settings
def analysis_connection():
    return connect(get_settings())
