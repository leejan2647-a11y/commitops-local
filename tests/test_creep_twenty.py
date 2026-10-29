import sys,unittest
from pathlib import Path
from datetime import date,timedelta
from decimal import Decimal
from types import SimpleNamespace
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'engine'))
from app.pipeline.baseline import Baseline,DailyPoint
from app.pipeline.detectors import detect_gradual_creep
from app.pipeline.creep_policy import required_growth
from app.pipeline.types import DataWindow

class CreepTwentyTests(unittest.TestCase):
 def check_rise(self,rise,threshold='20',days=56,step=False):
  start=date(2026,8,1);end=start+timedelta(days=days-1)
  points=[DailyPoint(start+timedelta(days=i),Decimal(10000)+(Decimal(rise) if step and i>=28 else Decimal(0) if step else Decimal(rise)*i/(days-1)),Decimal(1)) for i in range(days)]
  baseline=Baseline(series={('AmazonEC2','111111111111','us-east-1','BoxUsage'):points})
  return detect_gradual_creep('local',baseline,DataWindow(start,end,start-timedelta(days=31),start-timedelta(days=1)),creep_monthly_growth_percent=threshold)
 def test_twenty_percent_linear_normalisation(self):
  self.assertEqual(required_growth('20',56),Decimal(20)/100*56/30)
  self.assertFalse(self.check_rise(3700))
  self.assertTrue(self.check_rise(3800))
  self.assertTrue(self.check_rise(3700,'10'))
 def test_step_and_short_history_are_not_creep(self):
  self.assertFalse(self.check_rise(10000,step=True))
  self.assertFalse(self.check_rise(10000,days=30))
if __name__=='__main__':unittest.main()
